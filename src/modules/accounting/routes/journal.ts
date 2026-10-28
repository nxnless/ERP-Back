import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { accountingOnly, moduleAccess } from '../guard'
import { audit } from '../lib/audit'
import { accountsByCode, assertPeriodOpen, nextEntryNo, postEntry } from '../lib/ledger'
import { DATE, r2, today } from '../lib/rules'

export const journalRoutes = new Elysia()
  .use(accountingOnly)
  // ผังบัญชี + ยอดคงเหลือ (ตามด้านปกติของแต่ละบัญชี รวมทุกรายการที่ลงแล้ว)
  .get('/accounts', async () => await sql`
    SELECT a.code, a.name, a.type, a.normal_side, a.is_postable,
           COALESCE(sum(CASE a.normal_side WHEN 'D' THEN l.debit - l.credit ELSE l.credit - l.debit END), 0)::float8 AS balance
      FROM accounting.accounts a LEFT JOIN accounting.journal_lines l ON l.account_id = a.id
     WHERE a.active GROUP BY a.id ORDER BY a.code`, { beforeHandle: moduleAccess('accounting', 'read') })

  // สมุดรายวัน: รายการล่าสุดก่อน พร้อมบรรทัดเดบิต/เครดิต
  .get('/journal', async ({ query }) => {
    const limit = Math.min(query.limit ?? 30, 100), offset = query.offset ?? 0
    const [rows, [c]] = await Promise.all([
      sql`SELECT e.id, e.entry_no, e.entry_date, e.description, e.status, e.source_table,
                 json_agg(json_build_object('code', a.code, 'name', a.name, 'debit', l.debit::float8, 'credit', l.credit::float8) ORDER BY l.line_no) AS lines
            FROM accounting.journal_entries e
            JOIN accounting.journal_lines l ON l.entry_id = e.id JOIN accounting.accounts a ON a.id = l.account_id
           GROUP BY e.id ORDER BY e.entry_date DESC, e.created_at DESC, e.entry_no DESC LIMIT ${limit} OFFSET ${offset}`,
      sql`SELECT count(*)::int AS n FROM accounting.journal_entries`,
    ])
    return { rows, total: c.n }
  }, { beforeHandle: moduleAccess('accounting', 'read'), query: t.Object({ limit: t.Optional(t.Numeric()), offset: t.Optional(t.Numeric()) }) })

  // บันทึกรายการคู่: เดบิต 1 บัญชี เครดิต 1 บัญชี จำนวนเท่ากัน (ช่องทางเดียวกับที่ใช้ลงบัญชีด้วยมือ)
  .post('/journal', async ({ body, session, ip }) => {
    const desc = body.description.trim()
    if (!desc) throw new HttpError(422, 'ต้องใส่คำอธิบายรายการ')
    if (body.debit_code === body.credit_code) throw new HttpError(422, 'บัญชีเดบิตและเครดิตต้องเป็นคนละบัญชี')
    const amount = r2(body.amount)
    if (amount <= 0) throw new HttpError(422, 'จำนวนเงินต้องมากกว่า 0')
    const date = body.date ?? today()
    await assertPeriodOpen(date)
    const acc = await accountsByCode([body.debit_code, body.credit_code])
    const id = crypto.randomUUID(), no = await nextEntryNo()
    await sql.transaction([
      ...postEntry({ id, entry_no: no, date, description: desc, createdBy: session.userId, lines: [
        { account_id: acc.get(body.debit_code)!.id, debit: amount, credit: 0 }, { account_id: acc.get(body.credit_code)!.id, debit: 0, credit: amount }] }),
      audit({ session, ip }, { action: 'post_journal', table: 'accounting.journal_entries', id, ref: no, after: { debit: body.debit_code, credit: body.credit_code, amount, date } }),
    ])
    return { id, entry_no: no }
  }, {
    beforeHandle: moduleAccess('accounting', 'write'),
    body: t.Object({ description: t.String({ minLength: 1, maxLength: 200 }), debit_code: t.String(), credit_code: t.String(), amount: t.Number({ exclusiveMinimum: 0 }), date: t.Optional(DATE) }),
  })
