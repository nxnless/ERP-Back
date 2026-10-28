import { sql } from '../../../shared/db'
import { ROLE_TYPES, STALE_DAYS, TYPE_LABEL, fm, policyText, thDate } from './rules'

type Rows = [string, string][]
type Checks = [boolean, string][]
type Detail = { doc_no: string; title: string; rows: Rows; checks: Checks }

const PAYLOAD_LABEL: Record<string, string> = { name: 'ชื่อ', category: 'หมวดสินค้า', terms: 'เงื่อนไขชำระ', position: 'ตำแหน่ง', reason: 'เหตุผล', item: 'สินค้า', qty: 'จำนวน' }

/** รายละเอียดเฉพาะประเภท — โหลดทีละประเภทแบบ batch (ไม่ query ต่อรายการ) คืน Map ของ request id */
async function loadPo(ids: string[]) {
  const [pos, lines, prev] = await Promise.all([
    sql`SELECT r.id AS rid, po.id AS po_id, po.doc_no, po.party_name_snap, po.order_date, po.expected_date, po.rfq_quote_id, pr.doc_no AS pr_doc_no
          FROM platform.requests r JOIN purchasing.purchase_orders po ON po.id = r.ref_id
          LEFT JOIN purchasing.purchase_requisitions pr ON pr.id = po.pr_id WHERE r.id = ANY(${ids}::uuid[])`,
    sql`SELECT l.po_id, l.line_no, l.item_name_snap, l.qty::float8 AS qty, l.uom_snap FROM purchasing.po_lines l
          WHERE l.po_id IN (SELECT ref_id FROM platform.requests WHERE id = ANY(${ids}::uuid[])) ORDER BY l.po_id, l.line_no`,
    forwardedFrom(ids),
  ])
  const qids = pos.filter((p) => p.rfq_quote_id).map((p) => p.rfq_quote_id as string)
  const quotes = qids.length ? await sql`
    SELECT q.id, q.rfq_id, q.lead_time_days, rf.doc_no AS rfq_no,
           (SELECT sum(ql.unit_price * rl.qty) FROM purchasing.rfq_quote_lines ql JOIN purchasing.rfq_lines rl ON rl.id = ql.rfq_line_id WHERE ql.quote_id = q.id)::float8 AS total,
           ((SELECT count(*) FROM purchasing.rfq_quote_lines ql WHERE ql.quote_id = q.id) = (SELECT count(*) FROM purchasing.rfq_lines rl WHERE rl.rfq_id = q.rfq_id)) AS complete
      FROM purchasing.rfq_quotes q JOIN purchasing.rfqs rf ON rf.id = q.rfq_id
     WHERE q.rfq_id IN (SELECT rfq_id FROM purchasing.rfq_quotes WHERE id = ANY(${qids}::uuid[]))` : []
  const out = new Map<string, Detail>()
  for (const p of pos) {
    const L = lines.filter((l) => l.po_id === p.po_id)
    const first = L[0], title = first ? `${first.item_name_snap} ${fm(first.qty)} ${first.uom_snap}${L.length > 1 ? ` และอีก ${L.length - 1} รายการ` : ''}` : p.party_name_snap
    const rows: Rows = [['ผู้ขาย', p.party_name_snap]]
    const checks: Checks = []
    if (prev.get(p.rid)) rows.push(['ส่งต่อจาก', prev.get(p.rid) as string])
    if (p.pr_doc_no) rows.push(['ใบขอซื้อ', p.pr_doc_no])
    const chosen = quotes.find((q) => q.id === p.rfq_quote_id)
    if (chosen) {
      const peers = quotes.filter((q) => q.rfq_id === chosen.rfq_id && q.complete).sort((a, b) => a.total - b.total)
      const lowest = peers.length > 0 && chosen.total <= peers[0].total
      rows.push(['เปรียบเทียบราคา', `${chosen.rfq_no} · ${peers.length} ราย ${lowest ? 'ราคานี้ต่ำสุด' : 'ไม่ใช่ราคาต่ำสุด'} (${peers.map((q) => fm(q.total)).join(' / ')})`])
      checks.push([lowest, lowest ? 'เลือกผู้เสนอราคาต่ำสุด' : 'ไม่ได้เลือกผู้เสนอราคาต่ำสุด'])
      const fastest = Math.min(...peers.map((q) => q.lead_time_days as number)), late = (chosen.lead_time_days as number) - fastest
      checks.push([late <= 0, late > 0 ? `ส่งมอบช้ากว่ารายที่เร็วที่สุด ${late} วัน` : 'ส่งมอบเร็วที่สุดหรือเท่ากับรายที่เร็วที่สุด'])
    } else {
      rows.push(['เปรียบเทียบราคา', 'ไม่มี — ออก PO จากใบขอซื้อโดยตรง'])
      checks.push([false, 'ไม่ได้เปรียบเทียบราคาก่อนสั่งซื้อ'])
    }
    if (p.expected_date) rows.push(['ส่งมอบ', `${Math.round((new Date(p.expected_date).getTime() - new Date(p.order_date).getTime()) / 86400000)} วัน (${thDate(p.expected_date)})`])
    out.set(p.rid, { doc_no: p.doc_no, title, rows, checks })
  }
  return out
}

async function loadQuotation(ids: string[]) {
  const [qs, prev] = await Promise.all([
    sql`SELECT r.id AS rid, q.id AS qid, q.doc_no, q.party_name_snap, q.customer_id, q.total::float8 AS total, c.credit_limit::float8 AS credit_limit,
               pt.name AS terms_name,
               COALESCE((SELECT max(l.discount_pct) FROM sales.quotation_lines l WHERE l.quotation_id = q.id), 0)::float8 AS max_disc,
               COALESCE((SELECT sum(i.total - i.paid_amount) FROM accounting.invoices i WHERE i.direction = 'AR' AND i.party_id = q.customer_id AND i.status IN ('issued','verified','partially_paid')), 0)::float8 AS ar_out,
               COALESCE((SELECT sum(i.total - i.paid_amount) FROM accounting.invoices i WHERE i.direction = 'AR' AND i.party_id = q.customer_id AND i.status IN ('issued','verified','partially_paid') AND i.due_date < current_date), 0)::float8 AS ar_overdue
          FROM platform.requests r JOIN sales.quotations q ON q.id = r.ref_id JOIN master.customers c ON c.party_id = q.customer_id
          LEFT JOIN master.payment_terms pt ON pt.id = c.payment_terms_id WHERE r.id = ANY(${ids}::uuid[])`,
    forwardedFrom(ids),
  ])
  const qids = qs.map((q) => q.qid as string), cids = qs.map((q) => q.customer_id as string)
  const [disc, opp] = await Promise.all([
    sql`SELECT DISTINCT ON (d.ref_id) d.ref_id, u.display_name, s.acted_at FROM platform.requests d
          JOIN platform.request_steps s ON s.request_id = d.id AND s.status = 'approved' JOIN platform.users u ON u.id = s.approver_user_id
         WHERE d.type = 'QUOTATION_DISCOUNT' AND d.status = 'approved' AND d.ref_id = ANY(${qids}::uuid[]) ORDER BY d.ref_id, s.seq DESC`,
    sql`SELECT DISTINCT ON (o.party_id) o.party_id, st.name, st.probability FROM sales.opportunities o JOIN sales.crm_stages st ON st.code = o.stage_code
         WHERE o.party_id = ANY(${cids}::uuid[]) ORDER BY o.party_id, o.updated_at DESC`,
  ])
  const out = new Map<string, Detail>()
  for (const q of qs) {
    const rows: Rows = [['ลูกค้า', `${q.party_name_snap}${q.terms_name ? ` (${q.terms_name})` : ''}`]]
    const checks: Checks = []
    const d = disc.find((x) => x.ref_id === q.qid)
    if (q.max_disc > 0) {
      rows.push(['ส่วนลด', `${q.max_disc}%${d ? ` (${d.display_name} อนุมัติส่วนลดแล้ว ${thDate(d.acted_at)})` : ''}`])
      checks.push([!!d, d ? 'ส่วนลดผ่านการอนุมัติแล้ว' : 'ส่วนลดยังไม่มีบันทึกการอนุมัติ'])
    }
    rows.push(['สถานะลูกค้า', q.ar_overdue > 0 ? `มียอดค้างเกินกำหนด ${fm(q.ar_overdue)} บาท` : 'ไม่มียอดค้างเกินกำหนด'])
    checks.push([q.ar_overdue === 0, q.ar_overdue === 0 ? 'ลูกค้าไม่มียอดค้างเกินกำหนด' : 'ลูกค้ามียอดค้างเกินกำหนด'])
    if (q.credit_limit > 0) {
      const ok = q.credit_limit >= q.ar_out + q.total
      checks.push([ok, ok ? 'วงเงินเครดิตเพียงพอ' : `เกินวงเงินเครดิต (ค้าง ${fm(q.ar_out)} + ใบนี้ ${fm(q.total)} จากวงเงิน ${fm(q.credit_limit)})`])
    } else checks.push([false, 'ลูกค้ายังไม่ได้กำหนดวงเงินเครดิต'])
    const o = opp.find((x) => x.party_id === q.customer_id)
    if (o) rows.push(['โอกาสการขาย', `${o.name} · ความน่าจะเป็น ${o.probability}%`])
    if (prev.get(q.rid)) rows.push(['ส่งต่อจาก', prev.get(q.rid) as string])
    out.set(q.rid, { doc_no: q.doc_no, title: q.party_name_snap, rows, checks })
  }
  return out
}

async function loadLeave(ids: string[]) {
  const ls = await sql`
    SELECT r.id AS rid, lr.doc_no, lr.start_date, lr.end_date, lr.days::float8 AS days, lr.reason, lr.over_quota, lr.cert_missing,
           lt.name AS type_name, e.full_name, e.position,
           COALESCE((SELECT sum(g.days) FROM hr.leave_ledger g WHERE g.employee_id = lr.employee_id AND g.leave_type_code = lr.leave_type_code
                      AND g.year = extract(year FROM lr.start_date)::int), 0)::float8 AS balance
      FROM platform.requests r JOIN hr.leave_requests lr ON lr.request_id = r.id JOIN hr.leave_types lt ON lt.code = lr.leave_type_code
      JOIN hr.employees e ON e.id = lr.employee_id WHERE r.id = ANY(${ids}::uuid[])`
  const out = new Map<string, Detail>()
  for (const l of ls) {
    const rows: Rows = [['ช่วงลา', l.start_date === l.end_date ? thDate(l.start_date) : `${thDate(l.start_date)} – ${thDate(l.end_date)}`],
      ['สิทธิ์คงเหลือ', `${l.type_name} ${l.balance} วัน → เหลือ ${Math.round((l.balance - l.days) * 10) / 10} วัน`]]
    if (l.reason) rows.push(['เหตุผล', l.reason])
    const enough = !l.over_quota && l.balance >= l.days
    const checks: Checks = [[enough, enough ? 'สิทธิ์เพียงพอ' : 'เกินสิทธิ์คงเหลือ']]
    if (l.cert_missing) checks.push([false, 'ขาดใบรับรองแพทย์'])
    out.set(l.rid, { doc_no: l.doc_no, title: `${l.type_name} ${l.days} วัน · ${l.position}`, rows, checks })
  }
  return out
}

async function loadOt(ids: string[]) {
  const os = await sql`SELECT r.id AS rid, o.work_date, o.hours::float8 AS hours, o.reason, e.full_name, e.position
      FROM platform.requests r JOIN hr.ot_requests o ON o.request_id = r.id JOIN hr.employees e ON e.id = o.employee_id WHERE r.id = ANY(${ids}::uuid[])`
  return new Map<string, Detail>(os.map((o) => [o.rid as string, {
    doc_no: '', title: `ขอทำ OT ${o.hours} ชม. · ${o.position}`,
    rows: [['วันที่ทำ OT', thDate(o.work_date)], ['จำนวน', `${o.hours} ชม.`], ...(o.reason ? [['เหตุผล', o.reason] as [string, string]] : [])], checks: [],
  }]))
}

async function loadPr(ids: string[]) {
  const ps = await sql`
    SELECT r.id AS rid, pr.doc_no, pr.need_by, pr.reason, d.name AS dept,
           COALESCE(json_agg(json_build_object('d', l.description, 'q', l.qty::float8, 'u', l.uom, 't', l.est_total::float8) ORDER BY l.line_no) FILTER (WHERE l.id IS NOT NULL), '[]'::json) AS lines
      FROM platform.requests r JOIN purchasing.purchase_requisitions pr ON (pr.id = r.ref_id OR pr.approval_request_id = r.id) LEFT JOIN master.departments d ON d.id = pr.department_id
      LEFT JOIN purchasing.pr_lines l ON l.pr_id = pr.id WHERE r.id = ANY(${ids}::uuid[]) GROUP BY r.id, pr.id, d.name`
  return new Map<string, Detail>(ps.map((p) => {
    const L = p.lines as { d: string; q: number; u: string; t: number }[]
    const rows: Rows = L.map((l) => ['รายการ', `${l.d} ${fm(l.q)} ${l.u} (ประเมิน ${fm(l.t)} บาท)`] as [string, string])
    if (p.dept) rows.push(['แผนก', p.dept])
    if (p.need_by) rows.push(['ต้องการภายใน', thDate(p.need_by)])
    if (p.reason) rows.push(['เหตุผล', p.reason])
    return [p.rid as string, { doc_no: p.doc_no, title: L[0] ? `${L[0].d}${L.length > 1 ? ` และอีก ${L.length - 1} รายการ` : ''}` : p.doc_no, rows, checks: [] }]
  }))
}

/** คำขอที่มีแต่ payload (ซัพพลายเออร์ใหม่, อัตรากำลัง ฯลฯ) */
function fromPayload(r: { request_no: string; payload: Record<string, unknown> }): Detail {
  const p = r.payload ?? {}
  const rows = Object.entries(p).filter(([k, v]) => k !== 'summary' && k !== 'doc_no' && (typeof v === 'string' || typeof v === 'number') && v !== '')
    .map(([k, v]) => [PAYLOAD_LABEL[k] ?? k, String(v)] as [string, string])
  return { doc_no: (p.doc_no as string) ?? r.request_no, title: (p.summary as string) ?? (p.name as string) ?? r.request_no, rows, checks: [] }
}

/** ผู้อนุมัติขั้นก่อนหน้า → "ผู้จัดการ ณัฐพล · 6 ต.ค. 2569 17:05" */
async function forwardedFrom(ids: string[]) {
  const rows = await sql`
    SELECT DISTINCT ON (s.request_id) s.request_id, u.display_name, ro.name AS role_name, s.acted_at
      FROM platform.request_steps s JOIN platform.users u ON u.id = s.approver_user_id JOIN platform.roles ro ON ro.id = s.approver_role_id
     WHERE s.request_id = ANY(${ids}::uuid[]) AND s.status = 'approved' ORDER BY s.request_id, s.seq DESC`
  return new Map<string, string>(rows.map((r) => [r.request_id as string, `${r.role_name} ${r.display_name} · ${thDate(r.acted_at, true)}`]))
}

/**
 * รายการที่ขั้นปัจจุบันรอบทบาทใดบทบาทหนึ่งใน `roles` อนุมัติ พร้อมรายละเอียดครบสำหรับแผงขวา
 * roles มาจากโค้ดของ route (ตัดตามบทบาทที่ผู้ใช้ถือจริง) ไม่ใช่จากผู้ใช้ · แต่ละบทบาทเห็นเฉพาะประเภทที่กำหนดใน ROLE_TYPES
 */
export async function loadInbox(userId: string, roles: string[]) {
  if (!roles.length) return []
  const types = [...new Set(roles.flatMap((r) => ROLE_TYPES[r] ?? []))]
  const all = await sql`
    SELECT r.id, r.request_no, r.type, r.amount::float8 AS amount, r.payload, r.created_at, u.display_name AS requester_name, ro.code AS step_role,
           (SELECT string_agg(ro.name, ', ' ORDER BY ro.code) FROM platform.user_roles ur JOIN platform.roles ro ON ro.id = ur.role_id WHERE ur.user_id = r.requester_id) AS requester_roles,
           COALESCE((SELECT max(p.acted_at) FROM platform.request_steps p WHERE p.request_id = r.id AND p.status = 'approved'), r.created_at) AS waiting_since
      FROM platform.requests r JOIN platform.users u ON u.id = r.requester_id
      JOIN platform.request_steps s ON s.request_id = r.id AND s.status = 'pending'
      JOIN platform.roles ro ON ro.id = s.approver_role_id AND ro.code = ANY(${roles}::text[])
     WHERE r.status = 'pending' AND r.type = ANY(${types}::text[]) AND r.requester_id <> ${userId}
     ORDER BY waiting_since LIMIT 100`
  const reqs = all.filter((r) => (ROLE_TYPES[r.step_role as string] ?? []).includes(r.type as string))
  const policies = await sql`
    SELECT p.doc_type, p.min_amount::float8 AS min_amount, p.max_amount::float8 AS max_amount, ro.code AS role_code, ro.name AS role_name FROM platform.approval_policies p
      JOIN platform.roles ro ON ro.id = p.approver_role_id WHERE ro.code = ANY(${roles}::text[]) AND p.active`
  const of = (t: string) => reqs.filter((r) => r.type === t).map((r) => r.id as string)
  const run = <T,>(t: string, f: (ids: string[]) => Promise<Map<string, Detail>>) => (of(t).length ? f(of(t)) : Promise.resolve(new Map<string, Detail>()))
  const [po, qt, lv, ot, pr] = await Promise.all([run('PO', loadPo), run('QUOTATION', loadQuotation), run('LEAVE', loadLeave), run('OT', loadOt), run('PR', loadPr)])
  const typed = { PO: po, QUOTATION: qt, LEAVE: lv, OT: ot, PR: pr } as Record<string, Map<string, Detail>>
  const now = Date.now()
  return reqs.map((r) => {
    const d = typed[r.type]?.get(r.id) ?? fromPayload(r as any)
    const pol = policies.find((p) => p.role_code === r.step_role && p.doc_type === r.type && (r.amount ?? 0) >= p.min_amount && (p.max_amount == null || (r.amount ?? 0) <= p.max_amount))
    return {
      id: r.id as string, request_no: r.request_no as string, type: r.type as string, type_label: TYPE_LABEL[r.type as string],
      doc_no: d.doc_no || (r.request_no as string), title: d.title, amount: (r.amount as number) ?? 0,
      requester_name: r.requester_name as string, requester_roles: (r.requester_roles as string) ?? '',
      waiting_since: r.waiting_since as string, stale: now - new Date(r.waiting_since as string).getTime() > STALE_DAYS * 86400000,
      policy: policyText(r.type as string, pol, (pol?.role_name as string) ?? (r.step_role as string)), rows: d.rows, checks: d.checks,
    }
  })
}
