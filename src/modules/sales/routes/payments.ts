import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { moduleAccess } from '../guard'
import { audit } from '../lib/audit'
import { HOLD_OVERDUE_DAYS, UUID } from '../lib/rules'

/**
 * สถานะการชำระของลูกค้าในความดูแล (อ่านจากใบแจ้งหนี้ AR ของฝ่ายบัญชี — ดูอย่างเดียว)
 * ส่งออกเฉพาะเลขที่/ยอด/ครบกำหนด/สถานะ ไม่มีรายการสินค้า ต้นทุน หรือข้อมูลบัญชีอื่น
 */
export const paymentRoutes = new Elysia()
  .use(moduleAccess('sales'))
  .get('/receivables', async ({ branchId, teamIds }) => {
    const rows = await sql`
      SELECT i.id, i.doc_no, i.party_id, i.party_name_snap AS customer, i.total::float8 AS total, (i.total - i.paid_amount)::float8 AS balance,
             i.issue_date, i.due_date, i.status, GREATEST(current_date - i.due_date, 0)::int AS days_overdue
        FROM accounting.invoices i JOIN master.customers c ON c.party_id = i.party_id
       WHERE i.direction = 'AR' AND (c.owner_user_id = ANY(${teamIds}::uuid[]) OR c.branch_id = ${branchId}::uuid)
         AND (i.status IN ('issued','verified','partially_paid') OR (i.status = 'paid' AND i.issue_date >= current_date - 90))
       ORDER BY (i.total > i.paid_amount) DESC, i.due_date LIMIT 300`
    const open = rows.filter((r) => r.balance > 0)
    const overdue = open.filter((r) => r.days_overdue > 0)
    return {
      rows,
      summary: {
        outstanding: open.reduce((s, r) => s + r.balance, 0),
        overdue: overdue.reduce((s, r) => s + r.balance, 0), overdue_count: overdue.length,
        holds: new Set(open.filter((r) => r.days_overdue > HOLD_OVERDUE_DAYS).map((r) => r.party_id)).size,
      },
    }
  })

  // บันทึกการเตือนลูกค้า (ยังไม่ได้ส่งอีเมลจริง — ต่อระบบส่งอีเมลได้ที่จุดนี้)
  .post('/receivables/:id/remind', async ({ params, session, ip, branchId, teamIds }) => {
    const [i] = await sql`
      SELECT i.id, i.doc_no, i.party_name_snap, (i.total - i.paid_amount)::float8 AS balance, i.due_date
        FROM accounting.invoices i JOIN master.customers c ON c.party_id = i.party_id
       WHERE i.id = ${params.id} AND i.direction = 'AR' AND (c.owner_user_id = ANY(${teamIds}::uuid[]) OR c.branch_id = ${branchId}::uuid)`
    if (!i) throw new HttpError(404, 'ไม่พบใบแจ้งหนี้ในความดูแล')
    if (!(i.balance > 0)) throw new HttpError(409, 'ใบแจ้งหนี้นี้ชำระครบแล้ว')
    await sql.transaction([audit({ session, ip }, { action: 'remind_customer', table: 'accounting.invoices', id: i.id, ref: i.doc_no, after: { customer: i.party_name_snap, balance: i.balance } })])
    return { ok: true }
  }, { params: t.Object({ id: UUID }) })
