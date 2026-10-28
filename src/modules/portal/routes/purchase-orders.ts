import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { kindOnly } from '../guard'
import { audit } from '../lib/audit'
import { UUID } from '../lib/rules'

/**
 * ฝั่งซัพพลายเออร์: ใบสั่งซื้อที่ส่งมาถึงซัพพลายเออร์แล้ว (sent_to_supplier ขึ้นไป) — ยืนยัน PO และแจ้งจัดส่ง
 * stage 0..5 ตรงกับแถบสถานะบนหน้าจอ: ได้รับ PO / ยืนยัน / เตรียมสินค้า / จัดส่ง / ผู้ซื้อรับของ / ชำระเงิน
 * (เตรียมสินค้า = ขั้นแสดงผลเฉยๆ ไม่มีสถานะใน DB)
 */
const STAGE: Record<string, number> = { sent_to_supplier: 0, supplier_confirmed: 1, shipped: 3, partially_received: 3, received: 4 }

async function myPo(id: string, supplierId: string) {
  const [o] = await sql`SELECT id, doc_no, status FROM purchasing.purchase_orders WHERE id = ${id} AND supplier_id = ${supplierId}`
  if (!o) throw new HttpError(404, 'ไม่พบใบสั่งซื้อ')
  return o as { id: string; doc_no: string; status: string }
}

export const purchaseOrderRoutes = new Elysia()
  .use(kindOnly('supplier'))
  .get('/purchase-orders', async ({ me }) => {
    const rows = await sql`
      SELECT o.id, o.doc_no, o.total::float8 AS amount, o.expected_date, o.status,
             (SELECT s.tracking_no FROM purchasing.po_shipments s WHERE s.po_id = o.id ORDER BY s.shipped_at DESC LIMIT 1) AS tracking_no,
             EXISTS (SELECT 1 FROM portal.supplier_invoice_submissions x JOIN accounting.invoices i ON i.id = x.invoice_id WHERE x.po_id = o.id AND i.status = 'paid') AS paid,
             COALESCE((SELECT json_agg(json_build_object('name', l.item_name_snap, 'qty', l.qty::float8, 'uom', l.uom_snap) ORDER BY l.line_no)
                         FROM purchasing.po_lines l WHERE l.po_id = o.id), '[]'::json) AS lines
        FROM purchasing.purchase_orders o
       WHERE o.supplier_id = ${me.partyId} AND o.status IN ('sent_to_supplier','supplier_confirmed','shipped','partially_received','received')
       ORDER BY o.order_date DESC, o.doc_no DESC LIMIT 100`
    return rows.map((o) => ({ ...o, stage: o.paid ? 5 : STAGE[o.status] }))
  })

  .post('/purchase-orders/:id/confirm', async ({ params, me, ip }) => {
    const o = await myPo(params.id, me.partyId)
    if (o.status !== 'sent_to_supplier') throw new HttpError(409, 'ยืนยันได้เฉพาะ PO ที่เพิ่งได้รับ')
    await sql.transaction([
      sql`UPDATE purchasing.purchase_orders SET status = 'supplier_confirmed', updated_at = now() WHERE id = ${o.id} AND status = 'sent_to_supplier'`,
      audit({ me, ip }, { action: 'confirm_po', table: 'purchasing.purchase_orders', id: o.id, ref: o.doc_no, before: { status: o.status }, after: { status: 'supplier_confirmed' } }),
    ])
    return { ok: true }
  }, { params: t.Object({ id: UUID }) })

  .post('/purchase-orders/:id/ship', async ({ params, body, me, ip }) => {
    const o = await myPo(params.id, me.partyId)
    if (o.status !== 'supplier_confirmed') throw new HttpError(409, 'แจ้งจัดส่งได้เฉพาะ PO ที่ยืนยันแล้ว')
    const tracking = body.tracking_no.trim()
    await sql.transaction([
      sql`INSERT INTO purchasing.po_shipments (po_id, tracking_no, portal_user_id) VALUES (${o.id}, ${tracking}, ${me.id})`,
      sql`UPDATE purchasing.purchase_orders SET status = 'shipped', updated_at = now() WHERE id = ${o.id} AND status = 'supplier_confirmed'`,
      audit({ me, ip }, { action: 'ship_po', table: 'purchasing.purchase_orders', id: o.id, ref: o.doc_no, before: { status: o.status }, after: { status: 'shipped', tracking_no: tracking } }),
    ])
    return { ok: true }
  }, { params: t.Object({ id: UUID }), body: t.Object({ tracking_no: t.String({ minLength: 1, maxLength: 60 }) }) })
