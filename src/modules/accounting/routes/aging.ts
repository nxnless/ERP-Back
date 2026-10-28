import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { accountingOnly, moduleAccess } from '../guard'
import { audit } from '../lib/audit'
import { glBalance } from '../lib/ledger'
import { prepareRequest } from '../lib/requests'
import { AP_CONTROL, AR_CONTROL, UUID, beYear, r2, today } from '../lib/rules'

const OPEN = ['issued', 'verified', 'partially_paid']

export const agingRoutes = new Elysia()
  .use(accountingOnly)
  // อายุหนี้นับจากวันครบกำหนดชำระ ณ วันนี้ + เทียบกับบัญชีคุมยอดใน GL (ลูกหนี้ 1120 / เจ้าหนี้ 2110)
  .get('/aging', async ({ query }) => {
    const rows = await sql`
      SELECT party_id, party_name_snap AS party,
             COALESCE(sum(o) FILTER (WHERE due_date >= current_date), 0)::float8 AS not_due,
             COALESCE(sum(o) FILTER (WHERE current_date - due_date BETWEEN 1 AND 30), 0)::float8 AS d1_30,
             COALESCE(sum(o) FILTER (WHERE current_date - due_date BETWEEN 31 AND 60), 0)::float8 AS d31_60,
             COALESCE(sum(o) FILTER (WHERE current_date - due_date BETWEEN 61 AND 90), 0)::float8 AS d61_90,
             COALESCE(sum(o) FILTER (WHERE current_date - due_date > 90), 0)::float8 AS d90_plus,
             sum(o)::float8 AS total
        FROM (SELECT party_id, party_name_snap, due_date, total - paid_amount AS o FROM accounting.invoices
               WHERE direction = ${query.direction} AND status = ANY(${OPEN}::text[]) AND total - paid_amount > 0) x
       GROUP BY party_id, party_name_snap ORDER BY sum(o) DESC`
    const sum = (k: string) => r2(rows.reduce((s, r) => s + r[k], 0))
    const total = sum('total'), notDue = sum('not_due'), over60 = r2(sum('d61_90') + sum('d90_plus'))
    const gl = await glBalance(query.direction === 'AR' ? AR_CONTROL : AP_CONTROL, today())
    return {
      rows, totals: { not_due: notDue, d1_30: sum('d1_30'), d31_60: sum('d31_60'), d61_90: sum('d61_90'), d90_plus: sum('d90_plus'), total },
      overdue: r2(total - notDue), over60, gl_balance: gl, matches_gl: Math.abs(total - gl) < 0.005, gl_diff: r2(total - gl),
    }
  }, { beforeHandle: moduleAccess('accounting', 'read'), query: t.Object({ direction: t.Union([t.Literal('AR'), t.Literal('AP')]) }) })

  // ติดตามทวง: ระบบยังไม่มีการส่งอีเมล/หนังสือ — บันทึกการติดตามใน Audit Log (ใครทวงใคร เมื่อไร ยอดเกินกำหนดเท่าไร)
  .post('/aging/ar/:partyId/dunning', async ({ params, session, ip }) => {
    const [r] = await sql`
      SELECT max(party_name_snap) AS party, COALESCE(sum(total - paid_amount) FILTER (WHERE due_date < current_date), 0)::float8 AS overdue
        FROM accounting.invoices WHERE direction = 'AR' AND party_id = ${params.partyId} AND status = ANY(${OPEN}::text[])`
    if (!r?.party || r.overdue <= 0) throw new HttpError(409, 'ลูกค้ารายนี้ไม่มียอดเกินกำหนดชำระ')
    await audit({ session, ip }, { action: 'dunning_notice', table: 'master.parties', id: params.partyId, ref: r.party, after: { overdue: r.overdue } })
    return { ok: true, party: r.party, overdue: r.overdue }
  }, { beforeHandle: moduleAccess('accounting', 'write'), params: t.Object({ partyId: UUID }) })

  // เสนอจ่ายเจ้าหนี้: ตัดยอดจากใบแจ้งหนี้เก่าสุดก่อน → ใบสำคัญจ่ายสถานะ pending_approval + คำขอ PAYMENT ตามนโยบายอนุมัติ
  // (การลงบัญชีจ่ายและการอัปเดต paid_amount ทำเมื่อคำขอได้รับอนุมัติ — ไม่ใช่ที่นี่)
  .post('/aging/ap/:partyId/propose-payment', async ({ params, body, session, ip }) => {
    const invs = await sql`
      SELECT i.id, i.doc_no, i.party_name_snap AS party,
             (i.total - i.paid_amount - COALESCE((SELECT sum(pa.amount) FROM accounting.payment_allocations pa JOIN accounting.payments p ON p.id = pa.payment_id
                                                    WHERE pa.invoice_id = i.id AND p.status = 'pending_approval'), 0))::float8 AS available
        FROM accounting.invoices i
       WHERE i.direction = 'AP' AND i.party_id = ${params.partyId} AND i.status = ANY(${OPEN}::text[])
       ORDER BY i.due_date, i.doc_no`
    const open = invs.filter((i) => i.available > 0.004)
    const availableTotal = r2(open.reduce((s, i) => s + i.available, 0))
    if (!open.length) throw new HttpError(409, 'ไม่มียอดค้างจ่ายที่ยังไม่ได้เสนอจ่าย')
    const amount = r2(body.amount ?? availableTotal)
    if (amount <= 0 || amount > availableTotal) throw new HttpError(422, `จำนวนเงินต้องอยู่ระหว่าง 0.01 ถึง ${availableTotal}`)

    let left = amount
    const alloc = open.flatMap((i) => { if (left <= 0) return []; const a = r2(Math.min(i.available, left)); left = r2(left - a); return [{ invoice_id: i.id as string, doc_no: i.doc_no as string, amount: a }] })
    const bank = body.bank_account_id ?? (await sql`SELECT id FROM accounting.bank_accounts WHERE active ORDER BY code LIMIT 1`)[0]?.id ?? null
    const id = crypto.randomUUID(), party = open[0].party as string
    const [{ n }] = await sql`SELECT COALESCE(max(substring(doc_no from '[0-9]+$')::int), 0) + 1 AS n FROM accounting.payments WHERE doc_no LIKE ${'PV-' + beYear() + '-%'}`
    const docNo = `PV-${beYear()}-${String(n).padStart(4, '0')}`
    const req = await prepareRequest({
      type: 'PAYMENT', requesterId: session.userId, amount, ref: { table: 'accounting.payments', id },
      payload: { summary: `ขออนุมัติจ่ายเจ้าหนี้ ${party} · ยอด ${amount.toLocaleString('th-TH')} บาท`, party_id: params.partyId, party, amount, invoices: alloc.map((a) => a.doc_no), doc_no: docNo },
    })
    await sql.transaction([
      ...req.queries,
      sql`INSERT INTO accounting.payments (id, doc_no, direction, party_id, method, amount, paid_at, bank_account_id, status, approval_request_id, created_by)
          VALUES (${id}, ${docNo}, 'AP', ${params.partyId}, 'transfer', ${amount}, current_date, ${bank}, 'pending_approval', ${req.id}, ${session.userId})`,
      ...alloc.map((a) => sql`INSERT INTO accounting.payment_allocations (payment_id, invoice_id, amount) VALUES (${id}, ${a.invoice_id}, ${a.amount})`),
      audit({ session, ip }, { action: 'propose_payment', table: 'accounting.payments', id, ref: docNo, after: { party, amount, request: req.request_no, invoices: alloc.length }, risk: 'medium' }),
    ])
    return { id, doc_no: docNo, request_no: req.request_no, amount }
  }, {
    beforeHandle: moduleAccess('accounting', 'write'), params: t.Object({ partyId: UUID }),
    body: t.Object({ amount: t.Optional(t.Number({ exclusiveMinimum: 0 })), bank_account_id: t.Optional(UUID) }),
  })
