import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { needWrite, warehouseOnly } from '../guard'
import { UUID, pg, stockAt } from '../lib/rules'

/**
 * จ่ายสินค้าออกจากคลัง — ใบเบิกถูกสร้างโดยฝั่งขาย (ส่งของตามใบสั่งขาย) หรือคำขอเบิกภายใน (ISSUE) ส่วนคลัง "ยืนยันจ่ายจริง" เท่านั้น
 *  จ่ายได้เมื่อใบเบิกอยู่สถานะ pending (อนุมัติแล้ว) และยอดพร้อมใช้ (คงเหลือ − ที่ถูกจองโดยเอกสารอื่น) พอ
 *  จ่ายแล้ว: ตัดสต็อก + บันทึกการเคลื่อนไหว + ปล่อยการจองของเอกสารนั้น + audit ใน statement เดียว (สำเร็จทั้งหมดหรือไม่เลย)
 */
export const issueRoutes = new Elysia()
  .use(warehouseOnly)
  .get('/issues', async () => await sql`
    SELECT s.id, s.doc_no, s.issue_type, s.status, s.purpose, s.created_at, s.issued_at, s.warehouse_id, w.name AS warehouse_name,
           u.display_name AS requester_name, so.doc_no AS ref_doc_no,
           COALESCE((
             SELECT json_agg(json_build_object('id', l.id, 'item_id', l.item_id, 'sku', i.sku, 'name', i.name, 'uom', i.uom, 'qty', l.qty::float8,
                      'on_hand', COALESCE(b.on_hand, 0)::float8,
                      'reserved_other', COALESCE((SELECT sum(r.qty) FROM inventory.stock_reservations r
                                                   WHERE r.item_id = l.item_id AND r.warehouse_id = s.warehouse_id AND r.released_at IS NULL
                                                     AND NOT (r.ref_table IS NOT DISTINCT FROM s.ref_table AND r.ref_id IS NOT DISTINCT FROM s.ref_id)), 0)::float8) ORDER BY i.sku)
               FROM inventory.stock_issue_lines l JOIN master.items i ON i.id = l.item_id
               LEFT JOIN inventory.stock_balances b ON b.item_id = l.item_id AND b.warehouse_id = s.warehouse_id
              WHERE l.issue_id = s.id), '[]'::json) AS lines
      FROM inventory.stock_issues s
      JOIN master.warehouses w ON w.id = s.warehouse_id
      LEFT JOIN platform.users u ON u.id = s.requester_id
      LEFT JOIN sales.sales_orders so ON s.ref_table = 'sales.sales_orders' AND so.id = s.ref_id
     WHERE s.status IN ('pending_approval', 'pending') OR (s.status = 'issued' AND s.issued_at > now() - interval '30 days')
     ORDER BY (s.status = 'issued'), s.created_at DESC LIMIT 100`)

  .post('/issues/:id/issue', async ({ params, session, ip }) => {
    const [s] = await sql`SELECT id, doc_no, status, warehouse_id, ref_table, ref_id FROM inventory.stock_issues WHERE id = ${params.id}`
    if (!s) throw new HttpError(404, 'ไม่พบใบเบิก')
    if (s.status === 'pending_approval') throw new HttpError(409, 'ใบเบิกนี้ยังรออนุมัติ — จ่ายสินค้าไม่ได้')
    if (s.status !== 'pending') throw new HttpError(409, 'ใบเบิกนี้ดำเนินการไปแล้ว')

    const lines = await sql`SELECT item_id, qty::float8 AS qty FROM inventory.stock_issue_lines WHERE issue_id = ${s.id}`
    if (!lines.length) throw new HttpError(422, 'ใบเบิกไม่มีรายการสินค้า')
    const need = new Map<string, number>()
    for (const l of lines) need.set(l.item_id, (need.get(l.item_id) ?? 0) + l.qty)
    const stock = await stockAt(s.warehouse_id, [...need.keys()], { table: s.ref_table, id: s.ref_id })
    const short = [...need].filter(([id, q]) => (stock.get(id)?.available ?? 0) < q)
      .map(([id, q]) => `${stock.get(id)?.name ?? id} (ต้องการ ${q} พร้อมใช้ ${stock.get(id)?.available ?? 0})`)
    if (short.length) throw new HttpError(409, `สต็อกพร้อมใช้ไม่พอ: ${short.join(', ')} — แจ้งจัดซื้อหรือโอนจากคลังอื่น`)

    const uid = session.userId, after = JSON.stringify({ lines: lines.length, warehouse_id: s.warehouse_id })
    const [r] = await pg(() => sql`
      WITH claim AS (
        UPDATE inventory.stock_issues SET status = 'issued', issued_by = ${uid}::uuid, issued_at = now()
         WHERE id = ${s.id}::uuid AND status = 'pending' RETURNING id, doc_no, warehouse_id, ref_table, ref_id),
      need AS (SELECT l.item_id, sum(l.qty) AS qty FROM inventory.stock_issue_lines l JOIN claim c ON c.id = l.issue_id GROUP BY l.item_id),
      bal AS (UPDATE inventory.stock_balances b SET on_hand = b.on_hand - n.qty, updated_at = now()
                FROM need n, claim c WHERE b.item_id = n.item_id AND b.warehouse_id = c.warehouse_id RETURNING b.item_id),
      mv AS (INSERT INTO inventory.stock_movements (item_id, warehouse_id, bin_id, qty, movement_type, doc_table, doc_id, doc_no, created_by)
             SELECT l.item_id, c.warehouse_id, l.bin_id, -l.qty, 'issue', 'inventory.stock_issues', c.id, c.doc_no, ${uid}::uuid
               FROM inventory.stock_issue_lines l JOIN claim c ON c.id = l.issue_id RETURNING id),
      rel AS (UPDATE inventory.stock_reservations r SET released_at = now()
                FROM claim c WHERE c.ref_id IS NOT NULL AND r.ref_table = c.ref_table AND r.ref_id = c.ref_id
                 AND r.warehouse_id = c.warehouse_id AND r.released_at IS NULL AND r.item_id IN (SELECT item_id FROM need) RETURNING r.id),
      au AS (INSERT INTO audit.audit_log (actor_id, actor_name, actor_roles, action, module, entity_table, entity_id, entity_ref, after, ip, risk)
             SELECT ${uid}::uuid, ${session.name}::text, ${session.roles.join(',')}::text, 'issue_stock', 'inventory', 'inventory.stock_issues', c.id, c.doc_no,
                    ${after}::jsonb, ${ip}::inet, 'low' FROM claim c RETURNING id)
      SELECT (SELECT count(*) FROM claim)::int AS claimed`)
    if (!r.claimed) throw new HttpError(409, 'ใบเบิกนี้ถูกดำเนินการไปแล้ว')
    return { ok: true }
  }, { beforeHandle: needWrite, params: t.Object({ id: UUID }) })
