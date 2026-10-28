import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { accountingOnly, moduleAccess } from '../guard'
import { DATE, r2, today } from '../lib/rules'

/**
 * งบการเงินจากรายการที่ลงบัญชีแล้ว
 * งบแสดงฐานะการเงิน: ยอดสะสมถึงวันที่ `to` (กำไรสุทธิ = รายได้ − ค่าใช้จ่ายสะสม เพราะยังไม่มีรายการปิดบัญชีสิ้นปี)
 * งบกำไรขาดทุน: เฉพาะรายการในช่วง `from`–`to` (ค่าเริ่มต้น 1 ม.ค. ของปีนี้ถึงวันนี้)
 */
export const statementRoutes = new Elysia()
  .use(accountingOnly)
  .get('/statements', async ({ query }) => {
    const to = query.to ?? today(), from = query.from ?? `${to.slice(0, 4)}-01-01`
    const rows = await sql`
      SELECT a.code, a.name, a.type,
             COALESCE(sum(CASE a.normal_side WHEN 'D' THEN l.debit - l.credit ELSE l.credit - l.debit END) FILTER (WHERE e.entry_date <= ${to}::date), 0)::float8 AS balance,
             COALESCE(sum(CASE a.normal_side WHEN 'D' THEN l.debit - l.credit ELSE l.credit - l.debit END) FILTER (WHERE e.entry_date BETWEEN ${from}::date AND ${to}::date), 0)::float8 AS period_amount
        FROM accounting.accounts a
        LEFT JOIN accounting.journal_lines l ON l.account_id = a.id
        LEFT JOIN accounting.journal_entries e ON e.id = l.entry_id
       WHERE a.active GROUP BY a.id ORDER BY a.code`
    const of = (type: string, k: 'balance' | 'period_amount') => rows.filter((r) => r.type === type)
    const sum = (type: string, k: 'balance' | 'period_amount') => r2(of(type, k).reduce((s, r) => s + r[k], 0))
    const niCum = r2(sum('revenue', 'balance') - sum('expense', 'balance'))
    const niPeriod = r2(sum('revenue', 'period_amount') - sum('expense', 'period_amount'))
    const assets = sum('asset', 'balance'), liab = sum('liability', 'balance'), equity = r2(sum('equity', 'balance') + niCum)
    return {
      from, to,
      balance_sheet: { assets: of('asset', 'balance').filter((r) => r.balance !== 0), liabilities: of('liability', 'balance').filter((r) => r.balance !== 0), equity: of('equity', 'balance').filter((r) => r.balance !== 0),
        total_assets: assets, total_liabilities: liab, net_income: niCum, total_equity: equity, balanced: Math.abs(assets - (liab + equity)) < 0.005 },
      income_statement: { revenue: of('revenue', 'period_amount').filter((r) => r.period_amount !== 0), expenses: of('expense', 'period_amount').filter((r) => r.period_amount !== 0),
        total_revenue: sum('revenue', 'period_amount'), total_expenses: sum('expense', 'period_amount'), net_income: niPeriod,
        margin_pct: sum('revenue', 'period_amount') ? r2((niPeriod / sum('revenue', 'period_amount')) * 100) : null },
    }
  }, { beforeHandle: moduleAccess('accounting', 'read'), query: t.Object({ from: t.Optional(DATE), to: t.Optional(DATE) }) })
