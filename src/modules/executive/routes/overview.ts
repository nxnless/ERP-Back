import { Elysia } from 'elysia'
import { sql } from '../../../shared/db'
import { executiveOnly, moduleLevel } from '../guard'
import { DOC_TYPES } from '../../approvals/lib/rules'

/**
 * ภาพรวมบริษัท (อ่านอย่างเดียว) — แต่ละส่วนคืน null ถ้าบทบาทไม่มีสิทธิ์อ่านโมดูลที่เกี่ยวข้อง (หรือโมดูลถูกปิด)
 * ยอดขายรายสาขา: ใบสั่งขายที่อนุมัติแล้ว (ก่อน VAT) ตั้งแต่ต้นปี — schema ยังไม่มีตารางเป้าขาย จึงไม่แสดง % เทียบเป้า
 */
export const overviewRoutes = new Elysia()
  .use(executiveOnly)
  .get('/overview', async ({ session }) => {
    const [acc, sal, hr, aud] = await Promise.all(['accounting', 'sales', 'hr', 'audit'].map((m) => moduleLevel(session.roles, m)))

    const finance = acc < 1 ? null : await (async () => {
      const [[pl], [cash], [ar], [ap]] = await Promise.all([
        // รวมทุกรายการบัญชี (รายการที่ถูกกลับรายการจะหักล้างกันเอง)
        sql`SELECT COALESCE(sum(jl.credit - jl.debit) FILTER (WHERE a.type = 'revenue'), 0)::float8 AS revenue,
                   COALESCE(sum(jl.debit - jl.credit) FILTER (WHERE a.type = 'expense'), 0)::float8 AS expense
              FROM accounting.journal_lines jl JOIN accounting.journal_entries je ON je.id = jl.entry_id JOIN accounting.accounts a ON a.id = jl.account_id
             WHERE je.entry_date >= date_trunc('year', current_date) AND je.entry_date <= current_date`,
        sql`SELECT COALESCE(sum(jl.debit - jl.credit), 0)::float8 AS cash FROM accounting.journal_lines jl
             WHERE jl.account_id IN (SELECT gl_account_id FROM accounting.bank_accounts WHERE active)`,
        sql`SELECT COALESCE(sum(total - paid_amount), 0)::float8 AS n FROM accounting.invoices WHERE direction = 'AR' AND status IN ('issued','verified','partially_paid')`,
        sql`SELECT COALESCE(sum(total - paid_amount), 0)::float8 AS n FROM accounting.invoices WHERE direction = 'AP' AND status IN ('issued','verified','partially_paid')`,
      ])
      return { revenue: pl.revenue, expense: pl.expense, net: pl.revenue - pl.expense, cash: cash.cash, receivable: ar.n, payable: ap.n }
    })()

    const branches = sal < 1 ? null : await sql`
      SELECT b.id, b.name, COALESCE(sum(so.subtotal) FILTER (WHERE so.order_date >= date_trunc('year', current_date)), 0)::float8 AS sales
        FROM platform.branches b LEFT JOIN sales.sales_orders so ON so.branch_id = b.id AND so.status IN ('approved','ready_to_ship','partially_shipped','shipped','invoiced')
       WHERE b.active GROUP BY b.id, b.name ORDER BY sales DESC, b.name`

    const people = hr < 1 ? null : (await sql`
      SELECT count(*) FILTER (WHERE status IN ('probation','active'))::int AS headcount, count(*) FILTER (WHERE status = 'probation')::int AS probation,
             count(*) FILTER (WHERE status = 'resigned' AND termination_date >= date_trunc('year', current_date))::int AS resigned_ytd FROM hr.employees`)[0]

    // เหตุการณ์ความเสี่ยงสูงล่าสุด — แสดงแค่ใคร/ทำอะไร/เมื่อไร (ไม่มีค่าก่อน–หลัง)
    const risks = aud < 1 ? null : await sql`
      SELECT id, occurred_at, actor_name, action, module, entity_ref FROM audit.audit_log WHERE risk = 'high' ORDER BY occurred_at DESC, id DESC LIMIT 5`

    const policies = (await sql`
      SELECT p.doc_type, p.min_amount::float8 AS min_amount, p.max_amount::float8 AS max_amount, p.step_order, r.name AS role_name, p.condition_key
        FROM platform.approval_policies p JOIN platform.roles r ON r.id = p.approver_role_id WHERE p.active ORDER BY p.doc_type, p.step_order, p.min_amount`)
      .map((p) => ({ ...p, label: DOC_TYPES[p.doc_type as string] ?? p.doc_type }))

    const [{ today }] = await sql`SELECT to_char(current_date, 'YYYY-MM-DD') AS today`
    return { as_of: today as string, finance, branches, people, risks, policies }
  })
