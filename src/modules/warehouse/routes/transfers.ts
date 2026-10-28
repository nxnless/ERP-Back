import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { needWrite, warehouseOnly } from '../guard'
import { audit } from '../lib/audit'
import { withDocNo } from '../lib/docNo'
import { QTY, UUID, assertWarehouse, pg, stockAt } from '../lib/rules'

/**
 * โอนย้ายระหว่างคลัง: สร้างใบโอน → ตัดสต็อกต้นทางทันที (สถานะ "ระหว่างขนส่ง") → ปลายทางกด "รับเข้า" จึงเพิ่มสต็อกปลายทาง
 */
export const transferRoutes = new Elysia()
  .use(warehouseOnly)
  .get('/transfers', async () => await sql`
    SELECT t.id, t.doc_no, t.status, t.created_at, t.received_at, fw.name AS from_name, tw.name AS to_name, u.display_name AS actor_name,
           COALESCE((SELECT json_agg(json_build_object('sku', i.sku, 'name', i.name, 'uom', i.uom, 'qty', l.qty::float8) ORDER BY i.sku)
                       FROM inventory.stock_transfer_lines l JOIN master.items i ON i.id = l.item_id WHERE l.transfer_id = t.id), '[]'::json) AS lines
      FROM inventory.stock_transfers t
      JOIN master.warehouses fw ON fw.id = t.from_warehouse_id JOIN master.warehouses tw ON tw.id = t.to_warehouse_id
      LEFT JOIN platform.users u ON u.id = t.created_by
     ORDER BY (t.status = 'in_transit') DESC, t.created_at DESC LIMIT 50`)

  .post('/transfers', async ({ body, session, ip }) => {
    if (body.from_warehouse_id === body.to_warehouse_id) throw new HttpError(422, 'คลังต้นทางและปลายทางต้องไม่ใช่คลังเดียวกัน')
    const [from, to] = await Promise.all([assertWarehouse(body.from_warehouse_id), assertWarehouse(body.to_warehouse_id)])
    const ids = body.lines.map((l) => l.item_id)
    if (new Set(ids).size !== ids.length) throw new HttpError(422, 'มีสินค้าซ้ำในใบโอน')
    const stock = await stockAt(from.id, ids)
    if (stock.size !== ids.length) throw new HttpError(422, 'ไม่พบสินค้าบางรายการ')
    const short = body.lines.filter((l) => (stock.get(l.item_id)?.available ?? 0) < l.qty)
      .map((l) => `${stock.get(l.item_id)!.name} (พร้อมใช้ ${stock.get(l.item_id)!.available})`)
    if (short.length) throw new HttpError(409, `สต็อกในคลังต้นทางไม่พอ: ${short.join(', ')}`)

    const json = JSON.stringify(body.lines)
    const id = crypto.randomUUID()
    const ctx = { session, ip }
    return await pg(() => withDocNo('TRF', async (docNo) => {
      await sql.transaction([
        sql`INSERT INTO inventory.stock_transfers (id, doc_no, from_warehouse_id, to_warehouse_id, created_by) VALUES (${id}, ${docNo}, ${from.id}, ${to.id}, ${session.userId})`,
        sql`INSERT INTO inventory.stock_transfer_lines (transfer_id, item_id, qty)
            SELECT ${id}, x.item_id, x.qty FROM jsonb_to_recordset(${json}::jsonb) AS x(item_id uuid, qty numeric)`,
        sql`UPDATE inventory.stock_balances b SET on_hand = b.on_hand - x.qty, updated_at = now()
              FROM jsonb_to_recordset(${json}::jsonb) AS x(item_id uuid, qty numeric)
             WHERE b.item_id = x.item_id AND b.warehouse_id = ${from.id}`,
        sql`INSERT INTO inventory.stock_movements (item_id, warehouse_id, qty, movement_type, doc_table, doc_id, doc_no, created_by)
            SELECT x.item_id, ${from.id}, -x.qty, 'transfer_out', 'inventory.stock_transfers', ${id}, ${docNo}, ${session.userId}
              FROM jsonb_to_recordset(${json}::jsonb) AS x(item_id uuid, qty numeric)`,
        audit(ctx, { action: 'create_transfer', table: 'inventory.stock_transfers', id, ref: docNo, after: { from: from.code, to: to.code, lines: body.lines.length } }),
      ])
      return { id, doc_no: docNo }
    }))
  }, {
    beforeHandle: needWrite,
    body: t.Object({ from_warehouse_id: UUID, to_warehouse_id: UUID, lines: t.Array(t.Object({ item_id: UUID, qty: QTY }), { minItems: 1, maxItems: 50 }) }),
  })

  // ปลายทางรับเข้า — claim สถานะ + เพิ่มสต็อก + movement + audit ใน statement เดียว (กดซ้ำ/พร้อมกันจะไม่เพิ่มสต็อกสองครั้ง)
  .post('/transfers/:id/receive', async ({ params, session, ip }) => {
    const [tr] = await sql`SELECT id, status FROM inventory.stock_transfers WHERE id = ${params.id}`
    if (!tr) throw new HttpError(404, 'ไม่พบใบโอน')
    if (tr.status !== 'in_transit') throw new HttpError(409, 'ใบโอนนี้ไม่ได้อยู่ระหว่างขนส่ง')
    const uid = session.userId
    const [r] = await pg(() => sql`
      WITH claim AS (
        UPDATE inventory.stock_transfers SET status = 'received', received_at = now()
         WHERE id = ${tr.id}::uuid AND status = 'in_transit' RETURNING id, doc_no, to_warehouse_id),
      l AS (SELECT sl.item_id, sum(sl.qty) AS qty FROM inventory.stock_transfer_lines sl JOIN claim c ON c.id = sl.transfer_id GROUP BY sl.item_id),
      bal AS (INSERT INTO inventory.stock_balances (item_id, warehouse_id, on_hand)
              SELECT l.item_id, c.to_warehouse_id, l.qty FROM l, claim c
              ON CONFLICT (item_id, warehouse_id) DO UPDATE SET on_hand = inventory.stock_balances.on_hand + EXCLUDED.on_hand, updated_at = now()
              RETURNING item_id),
      mv AS (INSERT INTO inventory.stock_movements (item_id, warehouse_id, qty, movement_type, doc_table, doc_id, doc_no, created_by)
             SELECT sl.item_id, c.to_warehouse_id, sl.qty, 'transfer_in', 'inventory.stock_transfers', c.id, c.doc_no, ${uid}::uuid
               FROM inventory.stock_transfer_lines sl JOIN claim c ON c.id = sl.transfer_id RETURNING id),
      au AS (INSERT INTO audit.audit_log (actor_id, actor_name, actor_roles, action, module, entity_table, entity_id, entity_ref, ip, risk)
             SELECT ${uid}::uuid, ${session.name}::text, ${session.roles.join(',')}::text, 'receive_transfer', 'inventory', 'inventory.stock_transfers', c.id, c.doc_no,
                    ${ip}::inet, 'low' FROM claim c RETURNING id)
      SELECT (SELECT count(*) FROM claim)::int AS claimed`)
    if (!r.claimed) throw new HttpError(409, 'ใบโอนนี้ถูกรับเข้าไปแล้ว')
    return { ok: true }
  }, { beforeHandle: needWrite, params: t.Object({ id: UUID }) })
