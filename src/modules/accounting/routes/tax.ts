import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { accountingOnly, moduleAccess } from '../guard'
import { audit } from '../lib/audit'
import { submitEtax } from '../lib/etax'
import { MONTH, UUID, monthEnd, prevMonth, r2, validTaxId } from '../lib/rules'

/** ภาษีขาย/ซื้อของเดือน คำนวณจากใบกำกับที่ออกในเดือนนั้น (ไม่รวมฉบับร่าง/ยกเลิก) */
async function vatOf(month: string) {
  const rows = await sql`
    SELECT direction, COALESCE(sum(vat_amount), 0)::float8 AS vat FROM accounting.invoices
     WHERE issue_date BETWEEN ${month + '-01'}::date AND ${monthEnd(month)}::date AND status NOT IN ('draft', 'void') GROUP BY direction`
  const output = rows.find((r) => r.direction === 'AR')?.vat ?? 0, input = rows.find((r) => r.direction === 'AP')?.vat ?? 0
  return { output: r2(output), input: r2(input), payable: r2(output - input) }
}

export const taxRoutes = new Elysia()
  .use(accountingOnly)
  .get('/tax', async ({ query }) => {
    const month = query.month ?? prevMonth()
    const vat = await vatOf(month)
    const filings = await sql`SELECT id, form_code, period, amount::float8 AS amount, due_date, status, filed_at, reference FROM accounting.tax_filings WHERE period = ${month + '-01'}::date ORDER BY form_code`
    // ภ.พ.30 ที่ยังไม่ยื่น แสดงยอดสดจากใบกำกับเสมอ
    return { month, output_vat: vat.output, input_vat: vat.input, payable: vat.payable,
      filings: filings.map((f) => (f.form_code === 'PP30' && f.status !== 'filed' ? { ...f, amount: vat.payable } : f)) }
  }, { beforeHandle: moduleAccess('accounting', 'read'), query: t.Object({ month: t.Optional(MONTH) }) })

  // เตรียมแบบ ภ.พ.30 ของเดือน: ยอด = ภาษีขาย − ภาษีซื้อ กำหนดยื่นวันที่ 15 ของเดือนถัดไป (ยื่นแล้วจะไม่ถูกทับ)
  .post('/tax/filings/generate', async ({ body, session, ip }) => {
    const vat = await vatOf(body.month)
    const [y, m] = body.month.split('-').map(Number)
    const due = new Date(Date.UTC(y, m, 15)).toISOString().slice(0, 10)
    const [f] = await sql`
      INSERT INTO accounting.tax_filings (form_code, period, amount, due_date) VALUES ('PP30', ${body.month + '-01'}::date, ${vat.payable < 0 ? 0 : vat.payable}, ${due}::date)
      ON CONFLICT (form_code, period) DO UPDATE SET amount = EXCLUDED.amount WHERE accounting.tax_filings.status <> 'filed' RETURNING id`
    if (!f) throw new HttpError(409, 'ภ.พ.30 เดือนนี้ยื่นแล้ว')
    await audit({ session, ip }, { action: 'prepare_tax_filing', table: 'accounting.tax_filings', id: f.id, ref: `PP30 ${body.month}`, after: vat })
    return { id: f.id, ...vat }
  }, { beforeHandle: moduleAccess('accounting', 'write'), body: t.Object({ month: MONTH }) })

  .post('/tax/filings/:id/file', async ({ params, body, session, ip }) => {
    const [f] = await sql`SELECT id, form_code, to_char(period, 'YYYY-MM') AS month, status FROM accounting.tax_filings WHERE id = ${params.id}`
    if (!f) throw new HttpError(404, 'ไม่พบแบบภาษี')
    if (f.status === 'filed') throw new HttpError(409, 'ยื่นแล้ว')
    const amount = f.form_code === 'PP30' ? Math.max(0, (await vatOf(f.month)).payable) : null
    await sql.transaction([
      sql`UPDATE accounting.tax_filings SET status = 'filed', filed_at = now(), reference = ${body.reference?.trim() || null}, amount = COALESCE(${amount}::numeric, amount) WHERE id = ${params.id} AND status <> 'filed'`,
      audit({ session, ip }, { action: 'file_tax', table: 'accounting.tax_filings', id: params.id, ref: `${f.form_code} ${f.month}`, after: { reference: body.reference ?? null }, risk: 'medium' }),
    ])
    return { ok: true }
  }, { beforeHandle: moduleAccess('accounting', 'write'), params: t.Object({ id: UUID }), body: t.Object({ reference: t.Optional(t.String({ maxLength: 100 })) }) })

  // ---------- e-Tax Invoice (ใบกำกับฝั่งขาย) ----------
  .get('/tax/etax', async () => await sql`
    SELECT id, doc_no, party_name_snap AS party, total::float8 AS total, etax_status, etax_ref, etax_error, issue_date
      FROM accounting.invoices WHERE direction = 'AR' AND etax_status <> 'not_required' AND status <> 'void'
     ORDER BY issue_date DESC, doc_no DESC LIMIT 100`, { beforeHandle: moduleAccess('accounting', 'read') })

  // ส่งสรรพากร / แก้ไขและส่งซ้ำ: ฉบับที่ถูกปฏิเสธแก้เลขประจำตัวผู้เสียภาษีของผู้ซื้อได้ (ตรวจ check digit) ผ่านผู้ให้บริการที่ตั้งไว้ใน lib/etax.ts
  .post('/tax/etax/:id/send', async ({ params, body, session, ip }) => {
    const [inv] = await sql`SELECT id, doc_no, party_name_snap, party_tax_id_snap, total::float8 AS total, etax_status FROM accounting.invoices WHERE id = ${params.id} AND direction = 'AR'`
    if (!inv) throw new HttpError(404, 'ไม่พบใบกำกับภาษี')
    if (!['pending', 'rejected'].includes(inv.etax_status)) throw new HttpError(409, 'ใบกำกับนี้ส่งแล้วหรือไม่ต้องส่ง e-Tax')
    let taxId: string | null = inv.party_tax_id_snap
    if (body.party_tax_id) {
      if (!validTaxId(body.party_tax_id)) throw new HttpError(422, 'เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง (13 หลักและ check digit)')
      taxId = body.party_tax_id
    }
    const res = await submitEtax({ id: inv.id, doc_no: inv.doc_no, party_name: inv.party_name_snap, party_tax_id: taxId, total: inv.total })
    const ok = 'ref' in res
    await sql.transaction([
      sql`UPDATE accounting.invoices SET etax_status = ${ok ? 'sent' : 'rejected'}, etax_ref = ${ok ? res.ref : null}, etax_error = ${ok ? null : res.rejected},
                 party_tax_id_snap = ${taxId}, updated_at = now() WHERE id = ${params.id}`,
      audit({ session, ip }, { action: ok ? 'send_etax' : 'etax_rejected', table: 'accounting.invoices', id: params.id, ref: inv.doc_no, after: ok ? { ref: res.ref } : { error: res.rejected }, risk: 'medium' }),
    ])
    if (!ok) throw new HttpError(422, `กรมสรรพากรปฏิเสธ: ${res.rejected}`)
    return { ok: true, ref: res.ref }
  }, { beforeHandle: moduleAccess('accounting', 'write'), params: t.Object({ id: UUID }), body: t.Object({ party_tax_id: t.Optional(t.String()) }) })
