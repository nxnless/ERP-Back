import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { needWrite, warehouseOnly } from '../guard'
import { audit } from '../lib/audit'
import { withDocNo } from '../lib/docNo'
import { QTY0, RECEIVABLE, UUID, assertWarehouse, pg } from '../lib/rules'

/**
 * รับสินค้าเข้าคลัง (GRN) ตามใบสั่งซื้อ — ไม่ส่งราคาออกไป (ไม่ SELECT unit_price_snap / total)
 *  รับได้ไม่เกินจำนวนที่ค้างรับ (รับเกิน = ให้จัดซื้อแก้ใบสั่งซื้อก่อน) · ของชำรุดบันทึกใน GRN แต่ไม่เข้าสต็อก
 */
export const receivingRoutes = new Elysia()
  .use(warehouseOnly)
  .get('/receiving/pos', async () => await sql`
    SELECT p.id, p.doc_no, p.party_name_snap AS supplier_name, p.expected_date, p.status,
           json_agg(json_build_object('id', l.id, 'line_no', l.line_no, 'item_id', l.item_id, 'sku', i.sku, 'name', l.item_name_snap,
                                      'uom', l.uom_snap, 'qty', l.qty::float8, 'qty_received', l.qty_received::float8) ORDER BY l.line_no)
             FILTER (WHERE l.qty > l.qty_received) AS lines
      FROM purchasing.purchase_orders p
      JOIN purchasing.po_lines l ON l.po_id = p.id JOIN master.items i ON i.id = l.item_id
     WHERE p.status = ANY(${RECEIVABLE}::text[])
     GROUP BY p.id HAVING bool_or(l.qty > l.qty_received)
     ORDER BY p.expected_date NULLS LAST, p.doc_no`)

  .post('/receiving/grn', async ({ body, session, ip }) => {
    const [po] = await sql`SELECT id, doc_no, status FROM purchasing.purchase_orders WHERE id = ${body.po_id}`
    if (!po) throw new HttpError(404, 'ไม่พบใบสั่งซื้อ')
    if (!RECEIVABLE.includes(po.status)) throw new HttpError(409, 'ใบสั่งซื้อนี้ไม่อยู่ในสถานะที่รับสินค้าได้')
    const wh = await assertWarehouse(body.warehouse_id)

    const ids = body.lines.map((l) => l.po_line_id)
    if (new Set(ids).size !== ids.length) throw new HttpError(422, 'มีรายการซ้ำในใบรับสินค้า')
    const pls = await sql`SELECT id, po_id, item_id, item_name_snap AS name, qty::float8 AS qty, qty_received::float8 AS qty_received FROM purchasing.po_lines WHERE id = ANY(${ids}::uuid[])`
    const byId = new Map(pls.map((l) => [l.id as string, l]))

    const binIds = [...new Set(body.lines.map((l) => l.bin_id).filter((b): b is string => !!b))]
    if (binIds.length && (await sql`SELECT id FROM master.bins WHERE id = ANY(${binIds}::uuid[]) AND warehouse_id = ${wh.id}`).length !== binIds.length)
      throw new HttpError(422, 'ตำแหน่งจัดเก็บไม่ได้อยู่ในคลังที่เลือก')

    const rows = body.lines.map((l) => {
      const pl = byId.get(l.po_line_id)
      if (!pl || pl.po_id !== po.id) throw new HttpError(422, 'มีรายการที่ไม่อยู่ในใบสั่งซื้อนี้')
      const qa = l.qty_accepted, qr = l.qty_rejected ?? 0
      if (qa + qr <= 0) throw new HttpError(422, `${pl.name}: ต้องระบุจำนวนที่รับ`)
      if (qa + qr > pl.qty - pl.qty_received + 1e-9) throw new HttpError(422, `${pl.name}: รับเกินจำนวนที่สั่ง (ค้างรับ ${pl.qty - pl.qty_received}) — แจ้งจัดซื้อแก้ใบสั่งซื้อก่อน`)
      if (qr > 0 && !l.reject_reason?.trim()) throw new HttpError(422, `${pl.name}: ระบุเหตุผลที่ชำรุด/ไม่รับ`)
      return { po_line_id: l.po_line_id, item_id: pl.item_id as string, qa, qr, bin_id: l.bin_id ?? null, reason: qr > 0 ? l.reject_reason!.trim() : null }
    })
    const json = JSON.stringify(rows)
    const grnId = crypto.randomUUID()
    const ctx = { session, ip }

    const out = await pg(() => withDocNo('GRN', async (docNo) => {
      await sql.transaction([
        sql`INSERT INTO inventory.goods_receipts (id, doc_no, po_id, warehouse_id, received_by, note)
            VALUES (${grnId}, ${docNo}, ${po.id}, ${wh.id}, ${session.userId}, ${body.note?.trim() || null})`,
        sql`INSERT INTO inventory.goods_receipt_lines (grn_id, po_line_id, item_id, qty_accepted, qty_rejected, bin_id, reject_reason)
            SELECT ${grnId}, x.po_line_id, x.item_id, x.qa, x.qr, x.bin_id, x.reason
              FROM jsonb_to_recordset(${json}::jsonb) AS x(po_line_id uuid, item_id uuid, qa numeric, qr numeric, bin_id uuid, reason text)`,
        // ของชำรุดนับเป็น "รับแล้ว" บนใบสั่งซื้อ (ตามที่ออกแบบไว้) — CHECK qty_received <= qty กันรับเกินกรณีมีคนรับพร้อมกัน
        sql`UPDATE purchasing.po_lines SET qty_received = purchasing.po_lines.qty_received + x.qa + x.qr
              FROM jsonb_to_recordset(${json}::jsonb) AS x(po_line_id uuid, item_id uuid, qa numeric, qr numeric, bin_id uuid, reason text)
             WHERE purchasing.po_lines.id = x.po_line_id`,
        sql`INSERT INTO inventory.stock_balances (item_id, warehouse_id, on_hand)
            SELECT x.item_id, ${wh.id}, sum(x.qa)
              FROM jsonb_to_recordset(${json}::jsonb) AS x(po_line_id uuid, item_id uuid, qa numeric, qr numeric, bin_id uuid, reason text)
             WHERE x.qa > 0 GROUP BY x.item_id
            ON CONFLICT (item_id, warehouse_id) DO UPDATE SET on_hand = inventory.stock_balances.on_hand + EXCLUDED.on_hand, updated_at = now()`,
        sql`INSERT INTO inventory.stock_movements (item_id, warehouse_id, bin_id, qty, movement_type, doc_table, doc_id, doc_no, created_by)
            SELECT x.item_id, ${wh.id}, x.bin_id, x.qa, 'grn', 'inventory.goods_receipts', ${grnId}, ${docNo}, ${session.userId}
              FROM jsonb_to_recordset(${json}::jsonb) AS x(po_line_id uuid, item_id uuid, qa numeric, qr numeric, bin_id uuid, reason text)
             WHERE x.qa > 0`,
        sql`UPDATE purchasing.purchase_orders
               SET status = CASE WHEN EXISTS (SELECT 1 FROM purchasing.po_lines WHERE po_id = ${po.id} AND qty_received < qty) THEN 'partially_received' ELSE 'received' END,
                   updated_at = now()
             WHERE id = ${po.id}`,
        sql`INSERT INTO platform.doc_links (from_table, from_id, to_table, to_id) VALUES ('inventory.goods_receipts', ${grnId}, 'purchasing.purchase_orders', ${po.id}) ON CONFLICT DO NOTHING`,
        audit(ctx, { action: 'receive_goods', table: 'inventory.goods_receipts', id: grnId, ref: `${docNo} ← ${po.doc_no}`,
          after: { po: po.doc_no, warehouse: wh.code, lines: rows.length, rejected_lines: rows.filter((r) => r.qr > 0).length } }),
      ])
      return { id: grnId, doc_no: docNo }
    }))
    return out
  }, {
    beforeHandle: needWrite,
    body: t.Object({
      po_id: UUID, warehouse_id: UUID, note: t.Optional(t.String({ maxLength: 300 })),
      lines: t.Array(t.Object({
        po_line_id: UUID, qty_accepted: QTY0, qty_rejected: t.Optional(QTY0),
        bin_id: t.Optional(t.Union([UUID, t.Null()])), reject_reason: t.Optional(t.String({ maxLength: 200 })),
      }), { minItems: 1, maxItems: 100 }),
    }),
  })
