import { sql } from '../../../shared/db'
import type { Pending } from './decide'
import { TYPE_LABEL } from './rules'
import { fm, thd } from './util'

type Row = [string, string]
type Check = [boolean, string]
export type Detail = { title: string; ref_no?: string; rows: Row[]; checks: Check[]; confirm_text?: string }

/** ตัวอ่านรายละเอียดตามเอกสารต้นทาง (ref_table) — อ่านอย่างเดียว จำกัดที่สาขาของผู้จัดการ */
type Builder = (id: string, branchId: string) => Promise<Detail | null>

const salesOrder: Builder = async (id, branchId) => {
  const [o] = await sql`
    SELECT so.doc_no, so.party_name_snap AS party, so.total::float8 AS total, so.credit_check_ok, so.requested_delivery_date::text AS due,
           u.display_name AS sales, c.credit_limit::float8 AS credit_limit, pt.name AS terms,
           (SELECT count(*)::int FROM sales.sales_order_lines l WHERE l.sales_order_id = so.id) AS n,
           COALESCE((SELECT max(discount_pct) FROM sales.sales_order_lines l WHERE l.sales_order_id = so.id), 0)::float8 AS max_disc,
           COALESCE((SELECT sum(i.total - i.paid_amount) FROM accounting.invoices i
                      WHERE i.direction = 'AR' AND i.party_id = so.customer_id AND i.status IN ('issued','verified','partially_paid')), 0)::float8 AS ar_open
      FROM sales.sales_orders so
      JOIN master.customers c ON c.party_id = so.customer_id LEFT JOIN master.payment_terms pt ON pt.id = c.payment_terms_id
      JOIN platform.users u ON u.id = so.salesperson_id
     WHERE so.id = ${id} AND so.branch_id = ${branchId}`
  if (!o) return null
  const lines = await sql`
    SELECT l.item_name_snap AS name, l.qty::float8 AS qty,
           COALESCE((SELECT sum(b.on_hand) FROM inventory.stock_balances b JOIN master.warehouses w ON w.id = b.warehouse_id
                      WHERE b.item_id = l.item_id AND w.branch_id = ${branchId}), 0)::float8 AS on_hand,
           COALESCE((SELECT sum(rv.qty) FROM inventory.stock_reservations rv JOIN master.warehouses w ON w.id = rv.warehouse_id
                      WHERE rv.item_id = l.item_id AND rv.released_at IS NULL AND w.branch_id = ${branchId}), 0)::float8 AS reserved
      FROM sales.sales_order_lines l WHERE l.sales_order_id = ${id} ORDER BY l.line_no`
  const short = lines.filter((l) => l.qty > l.on_hand - l.reserved)
  const exposure = o.ar_open + o.total
  const checks: Check[] = [
    [o.credit_check_ok !== false, o.credit_check_ok === false ? 'ลูกค้าค้างชำระเกินกำหนด — ไม่ผ่านการตรวจเครดิตตอนสร้างใบสั่งขาย' : 'ผ่านการตรวจเครดิตตอนสร้างใบสั่งขาย'],
    ...(o.credit_limit > 0 ? [[exposure <= o.credit_limit, `ยอดค้าง + ใบนี้ ${fm(exposure)} จากวงเงินเครดิต ${fm(o.credit_limit)} บาท (${Math.round((exposure / o.credit_limit) * 100)}%)`] as Check] : []),
    [short.length === 0, short.length === 0 ? 'สต็อกพร้อมส่งครบทุกรายการ' : `สต็อกไม่พอ ${short.length} รายการ (${short[0].name} ขาด ${fm(short[0].qty - (short[0].on_hand - short[0].reserved))})`],
    [o.max_disc <= 5, o.max_disc <= 5 ? 'ไม่มีส่วนลดเกิน 5%' : `ส่วนลดสูงสุด ${o.max_disc}% (เกิน 5%)`],
  ]
  return {
    title: o.party, ref_no: o.doc_no, checks,
    rows: [['ลูกค้า', `${o.party}${o.terms ? ` (${o.terms})` : ''}`], ['ผู้ขอ', o.sales], ['รายการ', `${o.n} รายการ`], ['ส่วนลดสูงสุด', `${o.max_disc}%`], ['กำหนดส่ง', thd(o.due)]],
  }
}

const quotation: Builder = async (id, branchId) => {
  const [q] = await sql`
    SELECT q.doc_no, q.party_name_snap AS party, q.total::float8 AS total, q.valid_until::text AS valid_until, u.display_name AS sales,
           count(l.id)::int AS n, COALESCE(max(l.discount_pct), 0)::float8 AS max_disc,
           count(*) FILTER (WHERE l.unit_price_snap * (1 - l.discount_pct / 100) <
             COALESCE((SELECT c.cost FROM master.item_costs c WHERE c.item_id = l.item_id AND c.valid_from <= current_date ORDER BY c.valid_from DESC LIMIT 1), 0))::int AS below_cost
      FROM sales.quotations q JOIN platform.users u ON u.id = q.salesperson_id LEFT JOIN sales.quotation_lines l ON l.quotation_id = q.id
     WHERE q.id = ${id} AND q.branch_id = ${branchId} GROUP BY q.id, u.display_name`
  if (!q) return null
  return {
    title: q.party, ref_no: q.doc_no,
    rows: [['ลูกค้า', q.party], ['ผู้ขอ', q.sales], ['รายการ', `${q.n} รายการ`], ['ส่วนลดสูงสุด', `${q.max_disc}%`], ['ใช้ได้ถึง', thd(q.valid_until)]],
    checks: [[q.below_cost === 0, q.below_cost === 0 ? 'ไม่มีรายการขายต่ำกว่าต้นทุน' : `ขายต่ำกว่าต้นทุน ${q.below_cost} รายการ`]],
  }
}

const purchaseOrder: Builder = async (id, branchId) => {
  const [o] = await sql`
    SELECT po.doc_no, po.party_name_snap AS party, po.total::float8 AS total, po.expected_date::text AS expected, po.rfq_quote_id,
           u.display_name AS buyer, s.status AS supplier_status, (SELECT count(*)::int FROM purchasing.po_lines WHERE po_id = po.id) AS n
      FROM purchasing.purchase_orders po JOIN master.suppliers s ON s.party_id = po.supplier_id JOIN platform.users u ON u.id = po.buyer_id
     WHERE po.id = ${id} AND po.branch_id = ${branchId}`
  if (!o) return null
  const checks: Check[] = [[o.supplier_status === 'approved', o.supplier_status === 'approved' ? 'ผู้ขายอยู่ในรายชื่อผู้ขายที่อนุมัติ' : `สถานะผู้ขาย: ${o.supplier_status} (ยังไม่ใช่ผู้ขายที่อนุมัติ)`]]
  if (o.rfq_quote_id) {
    const quotes = await sql`
      SELECT q.id, sum(ql.unit_price * l.qty)::float8 AS total
        FROM purchasing.rfq_quotes q JOIN purchasing.rfq_quote_lines ql ON ql.quote_id = q.id JOIN purchasing.rfq_lines l ON l.id = ql.rfq_line_id
       WHERE q.rfq_id = (SELECT rfq_id FROM purchasing.rfq_quotes WHERE id = ${o.rfq_quote_id}) GROUP BY q.id`
    const mine = quotes.find((x) => x.id === o.rfq_quote_id)
    const lowest = !!mine && quotes.every((x) => x.id === o.rfq_quote_id || x.total >= mine.total)
    checks.push([quotes.length >= 3, `เปรียบเทียบราคา ${quotes.length} ราย${quotes.length >= 3 ? '' : ' (น้อยกว่า 3 ราย)'}`])
    checks.push([lowest, lowest ? 'ผู้ขายรายนี้เสนอราคาต่ำสุด' : 'ไม่ได้เลือกรายที่ราคาต่ำสุด — ดูเหตุผลในใบเปรียบเทียบราคา'])
  } else checks.push([false, 'ไม่ได้ผ่านการเปรียบเทียบราคา (RFQ)'])
  return {
    title: o.party, ref_no: o.doc_no, checks,
    rows: [['ผู้ขาย', o.party], ['ผู้ขอซื้อ', o.buyer], ['รายการ', `${o.n} รายการ`], ['กำหนดรับของ', thd(o.expected)]],
  }
}

const requisition: Builder = async (id, branchId) => {
  const [r] = await sql`
    SELECT pr.doc_no, pr.need_by::text AS need_by, pr.reason, u.display_name AS requester, d.name AS dept,
           COALESCE(sum(l.est_total), 0)::float8 AS est, count(l.id)::int AS n
      FROM purchasing.purchase_requisitions pr JOIN platform.users u ON u.id = pr.requester_id
      LEFT JOIN master.departments d ON d.id = pr.department_id LEFT JOIN purchasing.pr_lines l ON l.pr_id = pr.id
     WHERE pr.id = ${id} AND pr.branch_id = ${branchId} GROUP BY pr.id, u.display_name, d.name`
  if (!r) return null
  return {
    title: `ใบขอซื้อ ${r.doc_no}`, ref_no: r.doc_no, checks: [],
    rows: [['ผู้ขอ', `${r.requester}${r.dept ? ` · ${r.dept}` : ''}`], ['รายการ', `${r.n} รายการ · ประเมิน ${fm(r.est)} บาท`], ['ต้องการภายใน', thd(r.need_by)], ['เหตุผล', r.reason ?? '—']],
  }
}

const leave: Builder = async (id, branchId) => {
  const [l] = await sql`
    SELECT lr.doc_no, lr.employee_id, e.full_name, lt.name AS type_name, lr.start_date::text AS s, lr.end_date::text AS e, lr.days::float8 AS days, lr.reason,
           lr.over_quota, lr.cert_missing,
           COALESCE((SELECT sum(g.days) FROM hr.leave_ledger g WHERE g.employee_id = lr.employee_id AND g.leave_type_code = lr.leave_type_code
                      AND g.year = extract(year FROM lr.start_date)::int), 0)::float8 AS balance
      FROM hr.leave_requests lr JOIN hr.employees e ON e.id = lr.employee_id JOIN hr.leave_types lt ON lt.code = lr.leave_type_code
     WHERE lr.id = ${id} AND e.branch_id = ${branchId}`
  if (!l) return null
  const [ov] = await sql`
    SELECT count(*)::int AS n FROM hr.leave_requests o JOIN hr.employees oe ON oe.id = o.employee_id
     WHERE oe.department_id = (SELECT department_id FROM hr.employees WHERE id = ${l.employee_id})
       AND o.id <> ${id} AND o.status IN ('pending','approved') AND o.start_date <= ${l.e}::date AND o.end_date >= ${l.s}::date`
  return {
    title: `${l.type_name} ${l.days} วัน`, ref_no: l.doc_no,
    rows: [['ผู้ลา', l.full_name], ['ช่วงลา', l.s === l.e ? thd(l.s) : `${thd(l.s)} – ${thd(l.e)}`], ['สิทธิ์คงเหลือ', `${fm(l.balance)} วัน → เหลือ ${fm(l.balance - l.days)} วัน`], ['เหตุผล', l.reason ?? '—']],
    checks: [
      [l.balance >= l.days && !l.over_quota, l.balance >= l.days && !l.over_quota ? 'อยู่ในสิทธิ์ที่เหลือ' : 'เกินสิทธิ์คงเหลือ'],
      [!l.cert_missing, l.cert_missing ? 'ขาดใบรับรองแพทย์' : 'เอกสารประกอบครบ'],
      [ov.n === 0, ov.n === 0 ? 'ไม่ชนกับวันลาของคนอื่นในแผนกเดียวกัน' : `ชนกับวันลาของคนในแผนกเดียวกัน ${ov.n} คน`],
    ],
  }
}

const overtime: Builder = async (id, branchId) => {
  const [o] = await sql`
    SELECT e.full_name, ot.work_date::text AS d, ot.hours::float8 AS hours, ot.reason,
           COALESCE((SELECT sum(x.hours) FROM hr.ot_requests x WHERE x.employee_id = ot.employee_id AND x.status = 'approved'
                      AND date_trunc('month', x.work_date) = date_trunc('month', ot.work_date)), 0)::float8 AS month_hours
      FROM hr.ot_requests ot JOIN hr.employees e ON e.id = ot.employee_id WHERE ot.id = ${id} AND e.branch_id = ${branchId}`
  if (!o) return null
  return {
    title: `OT ${o.hours} ชม. · ${o.full_name}`, checks: [],
    rows: [['พนักงาน', o.full_name], ['วันที่', thd(o.d)], ['จำนวน', `${o.hours} ชม.`], ['OT เดือนนั้นที่อนุมัติแล้ว', `${fm(o.month_hours)} ชม.`], ['เหตุผล', o.reason ?? '—']],
  }
}

/** รอบเงินเดือน: แสดงเฉพาะยอดรวม — ไม่แสดงเงินเดือนรายบุคคล */
const payroll: Builder = async (id) => {
  const [p] = await sql`
    SELECT pr.run_no, pr.period::text AS period, pr.pay_date::text AS pay_date, pr.status, pr.headcount, pr.net_pay::float8 AS net,
           (SELECT x.net_pay::float8 FROM hr.payroll_runs x WHERE x.period < pr.period ORDER BY x.period DESC LIMIT 1) AS prev_net
      FROM hr.payroll_runs pr WHERE pr.id = ${id}`
  if (!p) return null
  const exc = await sql`SELECT description, confirmed_at IS NOT NULL AS confirmed FROM hr.payroll_exceptions WHERE run_id = ${id} ORDER BY description`
  const open = exc.filter((x) => !x.confirmed).length
  const delta = p.prev_net ? Math.round(((p.net - p.prev_net) / p.prev_net) * 1000) / 10 : null
  return {
    title: `เงินเดือน ${thd(p.period).replace(/^\d+ /, '')}`, ref_no: p.run_no,
    rows: [['พนักงาน', `${p.headcount} คน`], ['ยอดรวมสุทธิ', `${fm(p.net)} บาท`], ['เทียบเดือนก่อน', delta == null ? '—' : `${delta >= 0 ? '+' : ''}${delta}%`],
      ['รายการผิดปกติ', exc.length ? `${exc.length} รายการ: ${exc.map((x) => x.description).join(' · ')}` : 'ไม่มี'], ['วันจ่าย', thd(p.pay_date)]],
    checks: [
      [p.status === 'accounting_checked', p.status === 'accounting_checked' ? 'HR ส่งตรวจและบัญชีตรวจภาษี/ประกันสังคมแล้ว' : 'ยังไม่ผ่านการตรวจของบัญชี — อนุมัติไม่ได้'],
      [open === 0, open === 0 ? 'รายการผิดปกติได้รับการยืนยันครบ' : `มีรายการผิดปกติที่ยังไม่ยืนยัน ${open} รายการ`],
      [true, 'เป็นขั้นสุดท้าย — หลังอนุมัติจะส่งเข้ารอบจ่ายเงิน'],
    ],
    confirm_text: 'ฉันตรวจสอบยอดรวมและรายการผิดปกติแล้ว และยืนยันให้จ่ายเงินเดือน',
  }
}

const BUILDERS: Record<string, Builder> = {
  'sales.sales_orders': salesOrder, 'sales.quotations': quotation, 'purchasing.purchase_orders': purchaseOrder,
  'purchasing.purchase_requisitions': requisition, 'hr.leave_requests': leave, 'hr.ot_requests': overtime, 'hr.payroll_runs': payroll,
}

/** ชนิดที่ยังไม่มีตัวอ่านเฉพาะ (เบิกค่าใช้จ่าย จ่ายเจ้าหนี้ ฯลฯ) — แสดงจาก payload ที่ผู้ยื่นส่งมา */
function generic(p: Pending): Detail {
  const rows: Row[] = Object.entries(p.payload ?? {})
    .filter(([k, v]) => k !== 'summary' && v != null && typeof v !== 'object' && String(v) !== '')
    .slice(0, 12).map(([k, v]) => [k, String(v)])
  if (p.amount) rows.unshift(['จำนวนเงิน', `${fm(p.amount)} บาท`])
  return { title: String(p.payload?.summary ?? TYPE_LABEL[p.type] ?? p.type), rows, checks: [] }
}

export async function buildDetail(p: Pending, branchId: string): Promise<Detail> {
  const b = p.ref_table && p.ref_id ? BUILDERS[p.ref_table] : undefined
  return (b && (await b(p.ref_id!, branchId))) || generic(p)
}
