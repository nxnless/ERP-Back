import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { purchasingOnly } from '../guard'
import { issuePo, loadSupplier, toPoLines, userBranch } from '../lib/po'
import { UUID, round2 } from '../lib/rules'

/**
 * โหลด RFQ พร้อมใบเสนอราคาและคะแนน — คะแนนรวม 100 = ราคา 50 + ระยะเวลาส่งมอบ 25 + เงื่อนไขเครดิต 25
 * เทียบเฉพาะผู้เสนอราคาที่ "ครบทุกรายการ" (ราคารวม = Σ ราคา/หน่วย × จำนวน)
 */
async function loadRfqs(onlyId?: string) {
  const one = onlyId ?? null
  const rfqs = await sql`
    SELECT r.id, r.doc_no, r.title, r.status, r.closes_on, r.pr_id,
           (SELECT po.doc_no FROM purchasing.purchase_orders po JOIN purchasing.rfq_quotes q ON q.id = po.rfq_quote_id
             WHERE q.rfq_id = r.id AND po.status <> 'cancelled' ORDER BY po.created_at DESC LIMIT 1) AS po_doc_no
      FROM purchasing.rfqs r
     WHERE r.status <> 'cancelled' AND (${one}::uuid IS NULL OR r.id = ${one}::uuid)
     ORDER BY (r.status = 'open') DESC, r.created_at DESC LIMIT 50`
  const ids = rfqs.map((r) => r.id as string)
  const [lines, quotes, qlines] = await Promise.all([
    sql`SELECT id, rfq_id, line_no, item_id, description, qty::float8 AS qty, uom FROM purchasing.rfq_lines WHERE rfq_id = ANY(${ids}::uuid[]) ORDER BY rfq_id, line_no`,
    sql`SELECT q.id, q.rfq_id, q.supplier_id, p.name AS supplier_name, q.lead_time_days, q.payment_terms_id, q.valid_until, q.selected, q.justification,
               COALESCE(t.credit_days, st.credit_days, 0)::int AS credit_days
          FROM purchasing.rfq_quotes q JOIN master.suppliers s ON s.party_id = q.supplier_id JOIN master.parties p ON p.id = q.supplier_id
          LEFT JOIN master.payment_terms t ON t.id = q.payment_terms_id LEFT JOIN master.payment_terms st ON st.id = s.payment_terms_id
         WHERE q.rfq_id = ANY(${ids}::uuid[]) ORDER BY p.name`,
    sql`SELECT l.quote_id, l.rfq_line_id, l.unit_price::float8 AS unit_price FROM purchasing.rfq_quote_lines l
          JOIN purchasing.rfq_quotes q ON q.id = l.quote_id WHERE q.rfq_id = ANY(${ids}::uuid[])`,
  ])
  const price = new Map(qlines.map((x) => [`${x.quote_id}:${x.rfq_line_id}`, x.unit_price as number]))
  return rfqs.map((r) => {
    const L = lines.filter((l) => l.rfq_id === r.id)
    const Q = quotes.filter((q) => q.rfq_id === r.id).map((q) => {
      const prices: Record<string, number> = {}
      for (const l of L) { const p = price.get(`${q.id}:${l.id}`); if (p != null) prices[l.id as string] = p }
      const complete = L.length > 0 && L.every((l) => (l.id as string) in prices)
      const total = complete ? round2(L.reduce((s, l) => s + prices[l.id as string] * (l.qty as number), 0)) : null
      return { ...q, prices, complete, total, score: null as number | null, lowest: false, best: false }
    })
    const C = Q.filter((q) => q.complete)
    const minTotal = C.length ? Math.min(...C.map((q) => q.total as number)) : null
    const minLead = C.length ? Math.min(...C.map((q) => q.lead_time_days as number)) : 0
    const maxCredit = C.length ? Math.max(...C.map((q) => q.credit_days as number)) : 0
    for (const q of C) {
      const total = q.total as number, lead = q.lead_time_days as number
      q.score = Math.round(
        (total > 0 ? (minTotal as number) / total : 1) * 50 + (lead > 0 ? minLead / lead : 1) * 25 + (maxCredit > 0 ? (q.credit_days as number) / maxCredit : 1) * 25,
      )
      q.lowest = total === minTotal
    }
    const top = C.length ? Math.max(...C.map((q) => q.score as number)) : null
    for (const q of C) q.best = q.score === top
    return { ...r, lines: L, quotes: Q, min_total: minTotal }
  })
}

export const rfqRoutes = new Elysia()
  .use(purchasingOnly)
  .get('/rfqs', async () => await loadRfqs())

  // เลือกผู้เสนอราคา → ออก PO + ปิด RFQ (ไม่เลือกราคาต่ำสุดต้องมีเหตุผล)
  .post('/rfqs/:id/select', async ({ params, body, session, ip }) => {
    const [rfq] = await loadRfqs(params.id)
    if (!rfq) throw new HttpError(404, 'ไม่พบ RFQ')
    if (rfq.status !== 'open') throw new HttpError(409, 'RFQ นี้ปิดแล้ว')
    const q = rfq.quotes.find((x) => x.id === body.quote_id)
    if (!q) throw new HttpError(422, 'ไม่พบใบเสนอราคาที่เลือก')
    if (!q.complete) throw new HttpError(422, 'ผู้เสนอราคารายนี้ยังเสนอราคาไม่ครบทุกรายการ')
    const why = body.justification?.trim() ?? ''
    if ((q.total as number) > (rfq.min_total as number) && !why) throw new HttpError(422, 'ใส่เหตุผลที่ไม่เลือกราคาต่ำสุดก่อน')
    const supplier = await loadSupplier(q.supplier_id as string)
    const lines = await toPoLines(rfq.lines.map((l) => ({ item_id: l.item_id as string | null, description: l.description as string, uom: l.uom as string, qty: l.qty as number, price: q.prices[l.id as string] })))
    const [pr] = rfq.pr_id ? await sql`SELECT branch_id FROM purchasing.purchase_requisitions WHERE id = ${rfq.pr_id}` : []
    const branchId = await userBranch(session.userId, (pr?.branch_id as string | undefined) ?? null)
    return await issuePo({ session, ip }, {
      supplier, lines, branchId, prId: rfq.pr_id as string | null, rfqQuoteId: q.id as string,
      paymentTermsId: (q.payment_terms_id as string | null) ?? supplier.payment_terms_id, leadDays: q.lead_time_days as number,
      auditAction: 'issue_po_from_rfq', auditExtra: { rfq: rfq.doc_no, not_lowest: (q.total as number) > (rfq.min_total as number), justification: why || undefined },
      extra: (po) => [
        sql`UPDATE purchasing.rfq_quotes SET selected = true, justification = ${why || null} WHERE id = ${q.id}`,
        sql`UPDATE purchasing.rfqs SET status = 'closed' WHERE id = ${rfq.id} AND status = 'open'`,
        ...(rfq.pr_id ? [sql`UPDATE purchasing.purchase_requisitions SET status = 'po_issued', updated_at = now() WHERE id = ${rfq.pr_id} AND status = 'approved'`] : []),
        sql`INSERT INTO platform.doc_links (from_table, from_id, to_table, to_id) VALUES ('purchasing.rfqs', ${rfq.id}, 'purchasing.purchase_orders', ${po.id}) ON CONFLICT DO NOTHING`,
      ],
    })
  }, { params: t.Object({ id: UUID }), body: t.Object({ quote_id: UUID, justification: t.Optional(t.String({ maxLength: 300 })) }) })
