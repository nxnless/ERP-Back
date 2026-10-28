import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { kindOnly } from '../guard'
import { audit } from '../lib/audit'
import { UUID } from '../lib/rules'

/**
 * ฝั่งซัพพลายเออร์: วางบิล (ส่งใบแจ้งหนี้) สำหรับ PO ที่จัดส่งแล้ว + ดูสถานะการจ่ายเงิน
 * พอร์ทัลสร้างแค่ portal.supplier_invoice_submissions (submitted) — ฝ่ายจัดซื้อ/บัญชีตรวจรับแล้วจึงสร้าง accounting.invoices (AP) และตั้ง accepted
 */
export const supplierInvoiceRoutes = new Elysia()
  .use(kindOnly('supplier'))
  .get('/supplier-invoices', async ({ me }) => {
    const rows = await sql`
      SELECT x.id, x.invoice_no, x.amount::float8 AS amount, x.status, x.submitted_at, o.doc_no AS po_no, i.due_date, i.status AS invoice_status
        FROM portal.supplier_invoice_submissions x JOIN purchasing.purchase_orders o ON o.id = x.po_id LEFT JOIN accounting.invoices i ON i.id = x.invoice_id
       WHERE o.supplier_id = ${me.partyId} ORDER BY x.submitted_at DESC LIMIT 200`
    // PO ที่วางบิลได้: จัดส่งแล้ว/ผู้ซื้อรับแล้ว และยังเหลือยอดที่ยังไม่ได้วางบิล
    const payable = await sql`
      SELECT * FROM (
        SELECT o.id, o.doc_no, o.total::float8 AS total,
               (o.total - COALESCE((SELECT sum(x.amount) FROM portal.supplier_invoice_submissions x WHERE x.po_id = o.id AND x.status <> 'rejected'), 0))::float8 AS remaining
          FROM purchasing.purchase_orders o
         WHERE o.supplier_id = ${me.partyId} AND o.status IN ('shipped','partially_received','received')) p
       WHERE p.remaining > 0 ORDER BY p.doc_no DESC`
    return { rows, payable, waiting: rows.filter((r) => r.status !== 'rejected' && r.invoice_status !== 'paid').reduce((s, r) => s + r.amount, 0) }
  })

  .post('/supplier-invoices', async ({ body, me, ip }) => {
    const [o] = await sql`
      SELECT o.id, o.doc_no, o.status, o.total::float8 AS total,
             COALESCE((SELECT sum(x.amount) FROM portal.supplier_invoice_submissions x WHERE x.po_id = o.id AND x.status <> 'rejected'), 0)::float8 AS billed
        FROM purchasing.purchase_orders o WHERE o.id = ${body.po_id} AND o.supplier_id = ${me.partyId}`
    if (!o) throw new HttpError(404, 'ไม่พบใบสั่งซื้อ')
    if (!['shipped', 'partially_received', 'received'].includes(o.status)) throw new HttpError(409, 'วางบิลได้เฉพาะ PO ที่จัดส่งแล้ว')
    const no = body.invoice_no.trim()
    if (Math.round((o.billed + body.amount) * 100) > Math.round(o.total * 100)) throw new HttpError(422, `ยอดวางบิลเกินมูลค่า PO (เหลือวางบิลได้ ${Math.max(o.total - o.billed, 0).toLocaleString('th-TH')} บาท)`)
    const id = crypto.randomUUID()
    try {
      await sql.transaction([
        sql`INSERT INTO portal.supplier_invoice_submissions (id, po_id, portal_user_id, invoice_no, amount) VALUES (${id}, ${o.id}, ${me.id}, ${no}, ${body.amount})`,
        audit({ me, ip }, { action: 'submit_supplier_invoice', table: 'portal.supplier_invoice_submissions', id, ref: `${no} · ${o.doc_no}`, after: { po: o.doc_no, invoice_no: no, amount: body.amount }, risk: 'medium' }),
      ])
    } catch (e: any) {
      if (e?.code === '23505') throw new HttpError(409, 'เลขที่ใบแจ้งหนี้นี้เคยส่งสำหรับ PO นี้แล้ว')
      throw e
    }
    return { id }
  }, { body: t.Object({ po_id: UUID, invoice_no: t.String({ minLength: 1, maxLength: 40 }), amount: t.Number({ exclusiveMinimum: 0, maximum: 1_000_000_000 }) }) })
