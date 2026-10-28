import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { purchasingOnly } from '../guard'
import { audit } from '../lib/audit'
import { prepareRequest } from '../lib/approval'
import { nextNo, retryNo } from '../lib/docNo'
import { userBranch } from '../lib/po'
import { DEFAULT_LEAD_DAYS, UUID } from '../lib/rules'

export const supplierRoutes = new Elysia()
  .use(purchasingOnly)
  // เงื่อนไขชำระเงินสำหรับรายการเลือก
  .get('/meta', async () => ({
    terms: await sql`SELECT id, code, name, credit_days, deposit_pct::float8 AS deposit_pct FROM master.payment_terms ORDER BY credit_days, deposit_pct, name`,
  }))

  .get('/suppliers', async () => await sql`
    SELECT s.party_id AS id, p.code, p.name, s.category, s.status, s.lead_time_days, s.on_time_rate::float8 AS on_time_rate,
           s.payment_terms_id, t.name AS terms_name, COALESCE(t.credit_days, 0) AS credit_days,
           COALESCE(t.early_discount_pct, 0)::float8 AS early_discount_pct, COALESCE(t.early_discount_days, 0) AS early_discount_days,
           COALESCE((SELECT sum(i.total - i.paid_amount) FROM accounting.invoices i
                      WHERE i.direction = 'AP' AND i.party_id = s.party_id AND i.status IN ('issued','verified','partially_paid')), 0)::float8 AS payable
      FROM master.suppliers s JOIN master.parties p ON p.id = s.party_id LEFT JOIN master.payment_terms t ON t.id = s.payment_terms_id
     WHERE p.active ORDER BY p.name`)

  // เพิ่มซัพพลายเออร์ใหม่: เข้าสถานะ "ทดลอง" ซื้อได้ทันที พร้อมส่งคำขออนุมัติ (SUPPLIER) ตามนโยบาย
  .post('/suppliers', async ({ body, session, ip }) => {
    const name = body.name.trim(), category = body.category?.trim() || null
    if ((await sql`SELECT 1 FROM master.parties p JOIN master.party_roles r ON r.party_id = p.id AND r.role = 'supplier' WHERE lower(p.name) = lower(${name})`).length)
      throw new HttpError(409, 'มีซัพพลายเออร์ชื่อนี้อยู่แล้ว')
    const [terms] = await sql`SELECT id, name FROM master.payment_terms WHERE id = ${body.payment_terms_id}`
    if (!terms) throw new HttpError(422, 'ไม่พบเงื่อนไขชำระเงิน')
    const ctx = { session, ip }, id = crypto.randomUUID(), branchId = await userBranch(session.userId).catch(() => null)
    return retryNo(async () => {
      const code = await nextNo('SUP')
      const req = await prepareRequest(ctx, {
        type: 'SUPPLIER', amount: 0, branchId, refTable: 'master.suppliers', refId: id,
        payload: { summary: `${name} · ${category ?? '—'} · ${terms.name}`, name, category, terms: terms.name },
      })
      await sql.transaction([
        ...req.queries,
        sql`INSERT INTO master.parties (id, code, name) VALUES (${id}, ${code}, ${name})`,
        sql`INSERT INTO master.party_roles (party_id, role) VALUES (${id}, 'supplier')`,
        sql`INSERT INTO master.suppliers (party_id, category, payment_terms_id, lead_time_days, status, approval_request_id)
            VALUES (${id}, ${category}, ${terms.id}, ${DEFAULT_LEAD_DAYS}, 'trial', ${req.id})`,
        audit(ctx, { action: 'create_supplier', table: 'master.parties', id, ref: code, risk: 'medium',
          after: { name, category, terms: terms.name, status: 'trial', request: req.request_no, route: req.route } }),
      ])
      return { id, code, request_no: req.request_no, route: req.route }
    })
  }, { body: t.Object({ name: t.String({ minLength: 1, maxLength: 150 }), category: t.Optional(t.String({ maxLength: 80 })), payment_terms_id: UUID }) })

  // เปลี่ยนเงื่อนไขชำระเงินของซัพพลายเออร์ (กระทบกระแสเงินสด → risk กลาง)
  .put('/suppliers/:id/terms', async ({ params, body, session, ip }) => {
    const [s] = await sql`
      SELECT p.name, s.payment_terms_id, t.name AS terms_name FROM master.suppliers s JOIN master.parties p ON p.id = s.party_id
        LEFT JOIN master.payment_terms t ON t.id = s.payment_terms_id WHERE s.party_id = ${params.id}`
    if (!s) throw new HttpError(404, 'ไม่พบซัพพลายเออร์')
    const [n] = await sql`SELECT id, name FROM master.payment_terms WHERE id = ${body.payment_terms_id}`
    if (!n) throw new HttpError(422, 'ไม่พบเงื่อนไขชำระเงิน')
    if (s.payment_terms_id === n.id) return { ok: true }
    await sql.transaction([
      sql`UPDATE master.suppliers SET payment_terms_id = ${n.id} WHERE party_id = ${params.id}`,
      audit({ session, ip }, { action: 'update_supplier_terms', table: 'master.suppliers', id: params.id, ref: s.name, risk: 'medium',
        before: { terms: s.terms_name }, after: { terms: n.name } }),
    ])
    return { ok: true }
  }, { params: t.Object({ id: UUID }), body: t.Object({ payment_terms_id: UUID }) })
