import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { beYear, r2 } from './rules'

export type Line = { account_id: string; debit: number; credit: number; party_id?: string | null; memo?: string | null }

/** งวดบัญชีของวันที่ต้องไม่ปิดแล้ว (ยังไม่มีแถวงวด = เปิดอยู่ และจะถูกสร้างตอนลงบัญชี) */
export async function assertPeriodOpen(date: string) {
  const [p] = await sql`SELECT status FROM accounting.fiscal_periods WHERE year = ${Number(date.slice(0, 4))} AND month = ${Number(date.slice(5, 7))}`
  if (p?.status === 'closed') throw new HttpError(409, 'งวดบัญชีของวันที่นี้ปิดแล้ว ลงรายการไม่ได้')
}

/** เลขที่ JV ถัดไปของปี พ.ศ. นี้ เช่น JV-2569-1026 (ชนกันจะถูก UNIQUE ของ entry_no กันไว้) */
export async function nextEntryNo() {
  const p = `JV-${beYear()}-`
  const [r] = await sql`SELECT COALESCE(max(substring(entry_no from '[0-9]+$')::int), 1000) + 1 AS n FROM accounting.journal_entries WHERE entry_no LIKE ${p + '%'}`
  return p + r.n
}

export async function accountsByCode(codes: string[]) {
  const rows = await sql`SELECT id, code, name, is_postable, active FROM accounting.accounts WHERE code = ANY(${codes}::text[])`
  const m = new Map(rows.map((r) => [r.code as string, r as { id: string; code: string; name: string; is_postable: boolean; active: boolean }]))
  for (const c of codes) {
    const a = m.get(c)
    if (!a) throw new HttpError(422, `ไม่พบบัญชี ${c}`)
    if (!a.active || !a.is_postable) throw new HttpError(422, `บัญชี ${c} ${a.name} ลงรายการไม่ได้`)
  }
  return m
}

/**
 * คำสั่งลงบัญชีรายการคู่ (ยังไม่รัน): สร้างงวดถ้ายังไม่มี + หัวรายการ + บรรทัด — เดบิตต้องเท่าเครดิต
 * ใส่ใน sql.transaction([...]) คู่กับ audit และการเปลี่ยนแปลงที่เกี่ยวข้อง
 */
export function postEntry(a: { id: string; entry_no: string; date: string; description: string; lines: Line[]; createdBy: string; source?: { table: string; id: string } }) {
  const dr = r2(a.lines.reduce((s, l) => s + l.debit, 0)), cr = r2(a.lines.reduce((s, l) => s + l.credit, 0))
  if (dr !== cr || dr <= 0) throw new HttpError(422, 'เดบิตต้องเท่ากับเครดิต')
  const y = Number(a.date.slice(0, 4)), m = Number(a.date.slice(5, 7))
  return [
    sql`INSERT INTO accounting.fiscal_periods (year, month) VALUES (${y}, ${m}) ON CONFLICT (year, month) DO NOTHING`,
    sql`INSERT INTO accounting.journal_entries (id, entry_no, entry_date, period_id, description, source_table, source_id, created_by)
        VALUES (${a.id}, ${a.entry_no}, ${a.date}::date, (SELECT id FROM accounting.fiscal_periods WHERE year = ${y} AND month = ${m}),
                ${a.description}, ${a.source?.table ?? null}, ${a.source?.id ?? null}, ${a.createdBy})`,
    ...a.lines.map((l, i) => sql`INSERT INTO accounting.journal_lines (entry_id, line_no, account_id, debit, credit, party_id, memo)
        VALUES (${a.id}, ${i + 1}, ${l.account_id}, ${l.debit}, ${l.credit}, ${l.party_id ?? null}, ${l.memo ?? null})`),
  ]
}

/** ยอดคงเหลือของบัญชี ณ วันที่ (ตามด้านปกติของบัญชี) */
export async function glBalance(code: string, asOf: string) {
  const [r] = await sql`
    SELECT COALESCE(sum(CASE a.normal_side WHEN 'D' THEN l.debit - l.credit ELSE l.credit - l.debit END), 0)::float8 AS balance
      FROM accounting.accounts a
      LEFT JOIN accounting.journal_lines l ON l.account_id = a.id
      LEFT JOIN accounting.journal_entries e ON e.id = l.entry_id
     WHERE a.code = ${code} AND (e.id IS NULL OR e.entry_date <= ${asOf}::date)`
  return (r?.balance ?? 0) as number
}
