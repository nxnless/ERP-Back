import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { kindOnly } from '../guard'
import { audit } from '../lib/audit'
import { gatewayEnabled, startCharge } from '../lib/gateway'
import { CARD_FEE_PCT, PAYMENT_HOLD_HOURS, UUID, feeFor } from '../lib/rules'

const OPEN = ['issued', 'verified', 'partially_paid']

/**
 * ฝั่งลูกค้า: ใบแจ้งหนี้ (AR) ของบริษัทตนเอง + แจ้งชำระเงิน
 * พอร์ทัล "ไม่ลงบัญชีเอง" — แค่สร้างรายการ portal.online_payments สถานะ initiated
 * การตั้งเป็น paid / ออกใบเสร็จ / ตัดยอด paid_amount เป็นหน้าที่ของฝ่ายบัญชี (หรือ webhook ผู้ให้บริการ)
 */
export const invoiceRoutes = new Elysia()
  .use(kindOnly('customer'))
  .get('/invoices', async ({ me }) => {
    const [c] = await sql`
      SELECT c.credit_limit::float8 AS credit_limit, COALESCE(pt.credit_days, 0)::int AS credit_days
        FROM master.customers c LEFT JOIN master.payment_terms pt ON pt.id = c.payment_terms_id WHERE c.party_id = ${me.partyId}`
    const invoices = await sql`
      SELECT i.id, i.doc_no, i.issue_date, i.due_date, i.total::float8 AS total, (i.total - i.paid_amount)::float8 AS balance, i.status,
             (SELECT p.doc_no FROM accounting.payments p JOIN accounting.payment_allocations a ON a.payment_id = p.id
               WHERE a.invoice_id = i.id AND p.status = 'posted' ORDER BY p.paid_at DESC LIMIT 1) AS receipt_no,
             EXISTS (SELECT 1 FROM portal.online_payment_items it JOIN portal.online_payments op ON op.id = it.online_payment_id
                      WHERE it.invoice_id = i.id AND op.status = 'initiated' AND op.created_at > now() - make_interval(hours => ${PAYMENT_HOLD_HOURS}::int)) AS payment_pending
        FROM accounting.invoices i
       WHERE i.direction = 'AR' AND i.party_id = ${me.partyId} AND i.status IN ('issued','verified','partially_paid','paid')
         AND (i.status <> 'paid' OR i.issue_date >= current_date - 365)
       ORDER BY (i.total > i.paid_amount) DESC, i.due_date LIMIT 200`
    const history = await sql`
      SELECT p.doc_no, p.paid_at, p.method, p.amount::float8 AS amount FROM accounting.payments p
       WHERE p.direction = 'AR' AND p.party_id = ${me.partyId} AND p.status = 'posted' ORDER BY p.paid_at DESC, p.created_at DESC LIMIT 50`
    const [bank] = await sql`SELECT bank_name, account_no_masked FROM accounting.bank_accounts WHERE active ORDER BY code LIMIT 1`
    const open = invoices.filter((i) => OPEN.includes(i.status) && i.balance > 0)
    const outstanding = open.reduce((s, i) => s + i.balance, 0)
    return {
      summary: {
        outstanding, open_count: open.length, next_due: open.map((i) => i.due_date).sort()[0] ?? null,
        credit_limit: c?.credit_limit ?? 0, credit_days: c?.credit_days ?? 0,
        used_pct: c?.credit_limit > 0 ? Math.round((outstanding / c.credit_limit) * 100) : 0,
      },
      invoices, history,
      methods: { transfer: bank ?? null, promptpay: gatewayEnabled('promptpay'), card: gatewayEnabled('card'), card_fee_pct: CARD_FEE_PCT },
    }
  })

  .post('/payments', async ({ body, me, ip }) => {
    const ids = [...new Set(body.invoice_ids)]
    if (body.method !== 'transfer' && !gatewayEnabled(body.method)) throw new HttpError(503, 'ช่องทางนี้ยังไม่เปิดให้บริการ — เลือกโอนผ่านธนาคาร')
    // กรองด้วย party_id ของผู้ใช้เสมอ: ใส่ id ใบแจ้งหนี้ของบริษัทอื่นมาก็ไม่เจอ
    const inv = await sql`
      SELECT i.id, i.doc_no, (i.total - i.paid_amount)::float8 AS balance FROM accounting.invoices i
       WHERE i.id = ANY(${ids}::uuid[]) AND i.direction = 'AR' AND i.party_id = ${me.partyId} AND i.status = ANY(${OPEN}::text[]) AND i.total > i.paid_amount`
    if (inv.length !== ids.length) throw new HttpError(422, 'มีใบแจ้งหนี้ที่ชำระไม่ได้ (ชำระแล้ว ไม่พบ หรือไม่ใช่ของบริษัทคุณ)')
    if ((await sql`
      SELECT 1 FROM portal.online_payment_items it JOIN portal.online_payments op ON op.id = it.online_payment_id
       WHERE it.invoice_id = ANY(${ids}::uuid[]) AND op.status = 'initiated' AND op.created_at > now() - make_interval(hours => ${PAYMENT_HOLD_HOURS}::int) LIMIT 1`).length)
      throw new HttpError(409, 'ใบแจ้งหนี้บางใบมีรายการชำระที่รอยืนยันอยู่แล้ว')
    const amount = Math.round(inv.reduce((s, i) => s + i.balance, 0) * 100) / 100, fee = feeFor(body.method, amount)
    const id = crypto.randomUUID()
    const charge = body.method === 'transfer' ? null : await startCharge(body.method, amount + fee, id)
    if (body.method !== 'transfer' && !charge) throw new HttpError(503, 'เริ่มรายการชำระเงินไม่สำเร็จ ลองใหม่หรือเลือกโอนผ่านธนาคาร')
    await sql.transaction([
      sql`INSERT INTO portal.online_payments (id, party_id, portal_user_id, method, amount, fee, provider_ref)
          VALUES (${id}, ${me.partyId}, ${me.id}, ${body.method}, ${amount}, ${fee}, ${charge?.providerRef ?? null})`,
      sql`INSERT INTO portal.online_payment_items (online_payment_id, invoice_id, amount)
          SELECT ${id}, i.id, i.total - i.paid_amount FROM accounting.invoices i WHERE i.id = ANY(${ids}::uuid[])`,
      audit({ me, ip }, { action: 'initiate_payment', table: 'portal.online_payments', id, ref: inv.map((i) => i.doc_no).join(', '), after: { method: body.method, amount, fee, invoices: inv.length }, risk: 'medium' }),
    ])
    return { id, method: body.method, amount, fee, total: Math.round((amount + fee) * 100) / 100, invoices: inv.map((i) => i.doc_no), payload: charge?.payload ?? null }
  }, { body: t.Object({ invoice_ids: t.Array(UUID, { minItems: 1, maxItems: 50 }), method: t.Union([t.Literal('promptpay'), t.Literal('card'), t.Literal('transfer')]) }) })
