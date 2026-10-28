import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { kindOnly } from '../guard'
import { audit } from '../lib/audit'
import { UUID } from '../lib/rules'

/**
 * ฝั่งลูกค้า: ใบเสนอราคาที่ฝ่ายขาย "ส่งให้ลูกค้าแล้ว" เท่านั้น (ร่าง/รออนุมัติภายในไม่แสดง)
 * ไม่ส่งออก: ผู้ขาย ต้นทุน ข้อมูลอนุมัติภายใน
 */
export const quotationRoutes = new Elysia()
  .use(kindOnly('customer'))
  .get('/quotations', async ({ me }) => await sql`
    SELECT q.id, q.doc_no, q.quote_date, q.valid_until, q.subtotal::float8 AS subtotal,
           (SELECT count(*)::int FROM sales.quotation_lines l WHERE l.quotation_id = q.id) AS line_count,
           COALESCE((SELECT max(l.discount_pct) FROM sales.quotation_lines l WHERE l.quotation_id = q.id), 0)::float8 AS max_discount,
           CASE WHEN q.status = 'sent' AND q.valid_until < current_date THEN 'expired'
                WHEN q.status = 'sent' THEN 'pending' ELSE q.status END AS status,
           (SELECT o.doc_no FROM sales.sales_orders o WHERE o.quotation_id = q.id ORDER BY o.created_at LIMIT 1) AS so_no
      FROM sales.quotations q
     WHERE q.customer_id = ${me.partyId} AND q.status IN ('sent','accepted','declined','expired','converted')
     ORDER BY q.quote_date DESC, q.doc_no DESC LIMIT 100`)

  .post('/quotations/:id/respond', async ({ params, body, me, ip }) => {
    const [q] = await sql`SELECT id, doc_no, status, valid_until FROM sales.quotations WHERE id = ${params.id} AND customer_id = ${me.partyId}`
    if (!q) throw new HttpError(404, 'ไม่พบใบเสนอราคา')
    if (q.status !== 'sent') throw new HttpError(409, 'ใบเสนอราคานี้ตอบรับหรือปฏิเสธไม่ได้แล้ว')
    if (q.valid_until && new Date(q.valid_until) < new Date(new Date().toDateString())) throw new HttpError(409, 'ใบเสนอราคานี้หมดอายุแล้ว')
    const reason = body.reason?.trim() || null
    if (body.decision === 'declined' && !reason) throw new HttpError(422, 'กรุณาระบุเหตุผลที่ปฏิเสธ')
    // quote_responses มี UNIQUE (quotation_id) กันตอบซ้ำ
    await sql.transaction([
      sql`INSERT INTO portal.quote_responses (quotation_id, portal_user_id, decision, reason) VALUES (${q.id}, ${me.id}, ${body.decision}, ${reason})`,
      sql`UPDATE sales.quotations SET status = ${body.decision}, updated_at = now() WHERE id = ${q.id} AND status = 'sent'`,
      audit({ me, ip }, { action: body.decision === 'accepted' ? 'accept_quotation' : 'decline_quotation', table: 'sales.quotations', id: q.id, ref: q.doc_no, before: { status: 'sent' }, after: { status: body.decision, reason }, risk: 'medium' }),
    ])
    return { ok: true }
  }, { params: t.Object({ id: UUID }), body: t.Object({ decision: t.Union([t.Literal('accepted'), t.Literal('declined')]), reason: t.Optional(t.String({ maxLength: 300 })) }) })
