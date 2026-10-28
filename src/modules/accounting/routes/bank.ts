import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { accountingOnly, moduleAccess } from '../guard'
import { audit } from '../lib/audit'
import { accountsByCode, assertPeriodOpen, nextEntryNo, postEntry } from '../lib/ledger'
import { AR_CONTROL, MONTH, UUID, beYear, monthEnd, prevMonth, r2 } from '../lib/rules'

async function bankAccount(id?: string) {
  const [b] = id
    ? await sql`SELECT b.id, b.code, b.bank_name, b.account_no_masked, b.gl_account_id, a.code AS gl_code FROM accounting.bank_accounts b JOIN accounting.accounts a ON a.id = b.gl_account_id WHERE b.id = ${id} AND b.active`
    : await sql`SELECT b.id, b.code, b.bank_name, b.account_no_masked, b.gl_account_id, a.code AS gl_code FROM accounting.bank_accounts b JOIN accounting.accounts a ON a.id = b.gl_account_id WHERE b.active ORDER BY b.code LIMIT 1`
  if (!b) throw new HttpError(404, 'ไม่พบบัญชีธนาคาร')
  return b as { id: string; code: string; bank_name: string; account_no_masked: string; gl_account_id: string; gl_code: string }
}
async function bookBalance(glAccountId: string, asOf: string) {
  const [r] = await sql`
    SELECT COALESCE(sum(l.debit - l.credit), 0)::float8 AS b FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = ${glAccountId} AND e.entry_date <= ${asOf}::date`
  return r.b as number // บัญชีธนาคารเป็นสินทรัพย์ (ด้านปกติเดบิต)
}
async function loadLine(id: string) {
  const [l] = await sql`
    SELECT l.id, l.bank_account_id, l.txn_date, l.description, l.amount::float8 AS amount, l.match_status, b.gl_account_id, a.code AS gl_code
      FROM accounting.bank_statement_lines l JOIN accounting.bank_accounts b ON b.id = l.bank_account_id JOIN accounting.accounts a ON a.id = b.gl_account_id WHERE l.id = ${id}`
  if (!l) throw new HttpError(404, 'ไม่พบรายการในสเตทเมนต์')
  if (l.match_status !== 'unmatched') throw new HttpError(409, 'รายการนี้จับคู่แล้ว')
  return l as { id: string; bank_account_id: string; txn_date: string; description: string | null; amount: number; gl_account_id: string; gl_code: string }
}
const dateOnly = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10))

export const bankRoutes = new Elysia()
  .use(accountingOnly)
  .get('/bank/accounts', async () => await sql`SELECT id, code, bank_name, account_no_masked FROM accounting.bank_accounts WHERE active ORDER BY code`, { beforeHandle: moduleAccess('accounting', 'read') })

  // หน้ากระทบยอด: ยอดตามสเตทเมนต์ เช็คจ่ายยังไม่ขึ้นเงิน เงินฝากระหว่างทาง ยอดตามบัญชี (GL สด) และผลต่าง
  .get('/bank', async ({ query }) => {
    const month = query.month ?? prevMonth(), start = month + '-01', end = monthEnd(month)
    const acc = await bankAccount(query.bank_account_id)
    const [[rec], [last], lines, book] = await Promise.all([
      sql`SELECT id, statement_balance::float8 AS statement_balance, outstanding_cheques::float8 AS outstanding_cheques, deposits_in_transit::float8 AS deposits_in_transit, status FROM accounting.bank_reconciliations WHERE bank_account_id = ${acc.id} AND period = ${start}::date`,
      sql`SELECT running_balance::float8 AS b FROM accounting.bank_statement_lines WHERE bank_account_id = ${acc.id} AND txn_date <= ${end}::date AND running_balance IS NOT NULL ORDER BY txn_date DESC, id DESC LIMIT 1`,
      sql`SELECT l.id, l.txn_date, l.description, l.amount::float8 AS amount, l.match_status, e.entry_no
            FROM accounting.bank_statement_lines l LEFT JOIN accounting.journal_entries e ON e.id = l.matched_entry_id
           WHERE l.bank_account_id = ${acc.id} AND l.txn_date <= ${end}::date AND (l.txn_date >= ${start}::date OR l.match_status = 'unmatched')
           ORDER BY l.txn_date DESC, l.id`,
      bookBalance(acc.gl_account_id, end),
    ])
    const r = rec ?? { statement_balance: last?.b ?? 0, outstanding_cheques: 0, deposits_in_transit: 0, status: 'open' }
    return {
      account: acc, month, saved: !!rec, status: r.status,
      statement_balance: r.statement_balance, outstanding_cheques: r.outstanding_cheques, deposits_in_transit: r.deposits_in_transit,
      book_balance: r2(book), difference: r2(r.statement_balance - r.outstanding_cheques + r.deposits_in_transit - book),
      unmatched_count: lines.filter((l) => l.match_status === 'unmatched').length, lines,
    }
  }, { beforeHandle: moduleAccess('accounting', 'read'), query: t.Object({ bank_account_id: t.Optional(UUID), month: t.Optional(MONTH) }) })

  // บันทึกยอดตามสเตทเมนต์/เช็คค้าง/เงินฝากระหว่างทางของรอบ (รอบที่ปิดแล้วแก้ไม่ได้) — ยอดตามบัญชีถูกคำนวณจาก GL ณ วันสิ้นเดือน
  .put('/bank/reconciliation', async ({ body, session, ip }) => {
    const acc = await bankAccount(body.bank_account_id)
    const book = r2(await bookBalance(acc.gl_account_id, monthEnd(body.month)))
    const [r] = await sql`
      INSERT INTO accounting.bank_reconciliations (bank_account_id, period, statement_balance, book_balance, outstanding_cheques, deposits_in_transit)
      VALUES (${acc.id}, ${body.month + '-01'}::date, ${body.statement_balance}, ${book}, ${body.outstanding_cheques}, ${body.deposits_in_transit})
      ON CONFLICT (bank_account_id, period) DO UPDATE SET statement_balance = EXCLUDED.statement_balance, book_balance = EXCLUDED.book_balance,
             outstanding_cheques = EXCLUDED.outstanding_cheques, deposits_in_transit = EXCLUDED.deposits_in_transit
       WHERE accounting.bank_reconciliations.status = 'open' RETURNING id`
    if (!r) throw new HttpError(409, 'รอบนี้ปิดแล้ว แก้ไขไม่ได้')
    await audit({ session, ip }, { action: 'save_bank_reconciliation', table: 'accounting.bank_reconciliations', id: r.id, ref: `${acc.code} ${body.month}`,
      after: { statement_balance: body.statement_balance, outstanding_cheques: body.outstanding_cheques, deposits_in_transit: body.deposits_in_transit, book_balance: book } })
    return { id: r.id }
  }, {
    beforeHandle: moduleAccess('accounting', 'write'),
    body: t.Object({ bank_account_id: t.Optional(UUID), month: MONTH, statement_balance: t.Number(), outstanding_cheques: t.Number({ minimum: 0 }), deposits_in_transit: t.Number({ minimum: 0 }) }),
  })

  // ปิดรอบ: ผลต่างต้องเป็น 0 และไม่มีรายการในสเตทเมนต์ที่ยังไม่จับคู่
  .post('/bank/reconciliation/close', async ({ body, session, ip }) => {
    const acc = await bankAccount(body.bank_account_id)
    const [rec] = await sql`SELECT id, status, statement_balance::float8 AS s, outstanding_cheques::float8 AS c, deposits_in_transit::float8 AS d FROM accounting.bank_reconciliations WHERE bank_account_id = ${acc.id} AND period = ${body.month + '-01'}::date`
    if (!rec) throw new HttpError(409, 'ยังไม่ได้บันทึกยอดของรอบนี้')
    if (rec.status === 'closed') throw new HttpError(409, 'ปิดรอบไปแล้ว')
    const book = r2(await bookBalance(acc.gl_account_id, monthEnd(body.month)))
    const diff = r2(rec.s - rec.c + rec.d - book)
    if (diff !== 0) throw new HttpError(409, `ผลต่าง ${diff.toLocaleString('th-TH')} บาท — ปิดรอบได้เมื่อผลต่างเป็น 0`)
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM accounting.bank_statement_lines WHERE bank_account_id = ${acc.id} AND txn_date <= ${monthEnd(body.month)}::date AND match_status = 'unmatched'`
    if (n > 0) throw new HttpError(409, `ยังมีรายการในสเตทเมนต์ที่ยังไม่จับคู่ ${n} รายการ`)
    await sql.transaction([
      sql`UPDATE accounting.bank_reconciliations SET book_balance = ${book}, status = 'closed', closed_by = ${session.userId}, closed_at = now() WHERE id = ${rec.id} AND status = 'open'`,
      audit({ session, ip }, { action: 'close_bank_reconciliation', table: 'accounting.bank_reconciliations', id: rec.id, ref: `${acc.code} ${body.month}`, risk: 'medium' }),
    ])
    return { ok: true }
  }, { beforeHandle: moduleAccess('accounting', 'write'), body: t.Object({ bank_account_id: t.Optional(UUID), month: MONTH }) })

  // ลงบัญชีรายการที่ยังไม่จับคู่:
  //  receipt = รับชำระจากลูกหนี้ → JV (เดบิตธนาคาร/เครดิต 1120) + ใบเสร็จ RC + ตัดใบแจ้งหนี้เก่าสุดก่อน (sub-ledger ตรงกับ GL)
  //  entry   = รายการอื่น (เช่น ค่าธรรมเนียมธนาคาร) → JV กับบัญชีที่เลือก
  .post('/bank/lines/:id/post', async ({ params, body, session, ip }) => {
    const line = await loadLine(params.id)
    const date = dateOnly(line.txn_date)
    await assertPeriodOpen(date)
    const amt = r2(Math.abs(line.amount)), entryId = crypto.randomUUID(), no = await nextEntryNo()
    const txs: ReturnType<typeof sql>[] = []
    let description: string, after: Record<string, unknown>

    if (body.kind === 'receipt') {
      if (line.amount <= 0) throw new HttpError(422, 'บันทึกรับชำระได้เฉพาะรายการเงินเข้า')
      if (!body.party_id) throw new HttpError(422, 'ต้องระบุลูกหนี้')
      const [party] = await sql`SELECT name FROM master.parties WHERE id = ${body.party_id}`
      if (!party) throw new HttpError(422, 'ไม่พบลูกหนี้')
      const open = await sql`SELECT id, doc_no, (total - paid_amount)::float8 AS open FROM accounting.invoices
                              WHERE direction = 'AR' AND party_id = ${body.party_id} AND status IN ('issued','verified','partially_paid') AND total - paid_amount > 0 ORDER BY due_date, doc_no`
      const openTotal = r2(open.reduce((s, i) => s + i.open, 0))
      if (amt > openTotal) throw new HttpError(422, `จำนวนเงินเกินยอดค้างชำระของลูกหนี้ (${openTotal.toLocaleString('th-TH')} บาท)`)
      let left = amt
      const alloc = open.flatMap((i) => { if (left <= 0) return []; const a = r2(Math.min(i.open, left)); left = r2(left - a); return [{ id: i.id as string, doc_no: i.doc_no as string, amount: a }] })
      const acc = await accountsByCode([AR_CONTROL])
      const [{ n }] = await sql`SELECT COALESCE(max(substring(doc_no from '[0-9]+$')::int), 0) + 1 AS n FROM accounting.payments WHERE doc_no LIKE ${'RC-' + beYear() + '-%'}`
      const payId = crypto.randomUUID(), docNo = `RC-${beYear()}-${String(n).padStart(4, '0')}`
      description = `รับชำระ ${party.name} (กระทบยอดธนาคาร)`
      txs.push(
        ...postEntry({ id: entryId, entry_no: no, date, description, createdBy: session.userId, source: { table: 'accounting.payments', id: payId }, lines: [
          { account_id: line.gl_account_id, debit: amt, credit: 0 }, { account_id: acc.get(AR_CONTROL)!.id, debit: 0, credit: amt, party_id: body.party_id }] }),
        sql`INSERT INTO accounting.payments (id, doc_no, direction, party_id, method, amount, paid_at, bank_account_id, reference, status, journal_entry_id, created_by)
            VALUES (${payId}, ${docNo}, 'AR', ${body.party_id}, 'transfer', ${amt}, ${date}::date, ${line.bank_account_id}, ${line.description}, 'posted', ${entryId}, ${session.userId})`,
        ...alloc.flatMap((a) => [
          sql`INSERT INTO accounting.payment_allocations (payment_id, invoice_id, amount) VALUES (${payId}, ${a.id}, ${a.amount})`,
          sql`UPDATE accounting.invoices SET paid_amount = paid_amount + ${a.amount}::numeric, updated_at = now(),
                     status = CASE WHEN paid_amount + ${a.amount}::numeric >= total THEN 'paid' ELSE 'partially_paid' END WHERE id = ${a.id}`,
        ]),
      )
      after = { kind: 'receipt', party: party.name, amount: amt, receipt: docNo, invoices: alloc.map((a) => a.doc_no) }
    } else {
      if (!body.account_code) throw new HttpError(422, 'ต้องเลือกบัญชีที่ลงรายการ')
      if (body.account_code === line.gl_code) throw new HttpError(422, 'เลือกบัญชีธนาคารซ้ำไม่ได้')
      const acc = await accountsByCode([body.account_code])
      const contra = acc.get(body.account_code)!.id
      description = `${line.description ?? 'รายการธนาคาร'} (กระทบยอดธนาคาร)`
      const lines = line.amount > 0
        ? [{ account_id: line.gl_account_id, debit: amt, credit: 0 }, { account_id: contra, debit: 0, credit: amt }]
        : [{ account_id: contra, debit: amt, credit: 0 }, { account_id: line.gl_account_id, debit: 0, credit: amt }]
      txs.push(...postEntry({ id: entryId, entry_no: no, date, description, createdBy: session.userId, lines }))
      after = { kind: 'entry', account: body.account_code, amount: line.amount }
    }
    await sql.transaction([
      ...txs,
      sql`UPDATE accounting.bank_statement_lines SET match_status = 'adjusted', matched_entry_id = ${entryId}, matched_by = ${session.userId}, matched_at = now() WHERE id = ${params.id} AND match_status = 'unmatched'`,
      audit({ session, ip }, { action: 'post_bank_line', table: 'accounting.bank_statement_lines', id: params.id, ref: no, after, risk: 'medium' }),
    ])
    return { entry_no: no }
  }, {
    beforeHandle: moduleAccess('accounting', 'write'), params: t.Object({ id: UUID }),
    body: t.Object({ kind: t.Union([t.Literal('receipt'), t.Literal('entry')]), party_id: t.Optional(UUID), account_code: t.Optional(t.String()) }),
  })

  // จับคู่กับรายการที่ลงบัญชีไว้แล้ว: รายการต้องมีบรรทัดที่บัญชีธนาคารและจำนวนตรงกับสเตทเมนต์ และยังไม่ถูกจับคู่กับบรรทัดอื่น
  .post('/bank/lines/:id/match', async ({ params, body, session, ip }) => {
    const line = await loadLine(params.id)
    const [e] = await sql`SELECT e.id, e.entry_no, COALESCE(sum(l.debit - l.credit) FILTER (WHERE l.account_id = ${line.gl_account_id}), 0)::float8 AS bank_net,
                                 EXISTS (SELECT 1 FROM accounting.bank_statement_lines x WHERE x.matched_entry_id = e.id) AS taken
                            FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id = e.id WHERE e.id = ${body.entry_id} GROUP BY e.id`
    if (!e) throw new HttpError(404, 'ไม่พบรายการบัญชี')
    if (e.taken) throw new HttpError(409, 'รายการบัญชีนี้ถูกจับคู่กับสเตทเมนต์แล้ว')
    if (r2(e.bank_net) !== r2(line.amount)) throw new HttpError(422, 'จำนวนเงินที่บัญชีธนาคารไม่ตรงกับรายการในสเตทเมนต์')
    await sql.transaction([
      sql`UPDATE accounting.bank_statement_lines SET match_status = 'matched', matched_entry_id = ${e.id}, matched_by = ${session.userId}, matched_at = now() WHERE id = ${params.id} AND match_status = 'unmatched'`,
      audit({ session, ip }, { action: 'match_bank_line', table: 'accounting.bank_statement_lines', id: params.id, ref: e.entry_no }),
    ])
    return { ok: true }
  }, { beforeHandle: moduleAccess('accounting', 'write'), params: t.Object({ id: UUID }), body: t.Object({ entry_id: UUID }) })
