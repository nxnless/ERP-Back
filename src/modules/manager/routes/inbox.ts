import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { managerOnly } from '../guard'
import { approve, forward, loadPending, reject } from '../lib/decide'
import { buildDetail } from '../lib/detail'
import { APPROVAL_LIMIT, TYPE_LABEL, UUID, overLimit } from '../lib/rules'

const Body = t.Object({ comment: t.Optional(t.String({ maxLength: 300 })), confirm: t.Optional(t.Boolean()) })

/**
 * กล่องงานรออนุมัติ — แสดงเฉพาะคำขอที่ "ขั้นปัจจุบันรอบทบาทผู้จัดการ" ในสาขาเดียวกัน และไม่ใช่ของตนเอง
 * (ข้อกำหนด: requests.branch_id ต้องถูกกำหนดตอนยื่นคำขอ ไม่งั้นจะไม่ขึ้นในกล่องของใคร)
 */
export const inboxRoutes = new Elysia()
  .use(managerOnly)
  .get('/inbox', async ({ session, branchId }) => {
    const rows = await sql`
      SELECT r.id, r.request_no, r.type, r.amount::float8 AS amount, r.created_at, u.display_name AS requester_name,
             (extract(epoch FROM now() - r.created_at) / 3600)::float8 AS waiting_hours,
             (r.payload->>'urgent') = 'true' AS urgent,
             CASE r.ref_table
               WHEN 'sales.sales_orders' THEN (SELECT doc_no FROM sales.sales_orders WHERE id = r.ref_id)
               WHEN 'sales.quotations' THEN (SELECT doc_no FROM sales.quotations WHERE id = r.ref_id)
               WHEN 'purchasing.purchase_orders' THEN (SELECT doc_no FROM purchasing.purchase_orders WHERE id = r.ref_id)
               WHEN 'purchasing.purchase_requisitions' THEN (SELECT doc_no FROM purchasing.purchase_requisitions WHERE id = r.ref_id)
               WHEN 'hr.leave_requests' THEN (SELECT doc_no FROM hr.leave_requests WHERE id = r.ref_id)
               WHEN 'hr.payroll_runs' THEN (SELECT run_no FROM hr.payroll_runs WHERE id = r.ref_id)
             END AS ref_no,
             COALESCE(NULLIF(r.payload->>'summary', ''),
               CASE r.ref_table
                 WHEN 'sales.sales_orders' THEN (SELECT party_name_snap FROM sales.sales_orders WHERE id = r.ref_id)
                 WHEN 'sales.quotations' THEN (SELECT party_name_snap FROM sales.quotations WHERE id = r.ref_id)
                 WHEN 'purchasing.purchase_orders' THEN (SELECT party_name_snap FROM purchasing.purchase_orders WHERE id = r.ref_id)
                 WHEN 'hr.leave_requests' THEN (SELECT lt.name || ' ' || lr.days::text || ' วัน' FROM hr.leave_requests lr JOIN hr.leave_types lt ON lt.code = lr.leave_type_code WHERE lr.id = r.ref_id)
                 WHEN 'hr.payroll_runs' THEN (SELECT 'เงินเดือน ' || to_char(period, 'MM/YYYY') FROM hr.payroll_runs WHERE id = r.ref_id)
               END) AS title
        FROM platform.requests r
        JOIN platform.users u ON u.id = r.requester_id
        JOIN platform.request_steps s ON s.request_id = r.id AND s.status = 'pending'
        JOIN platform.roles ro ON ro.id = s.approver_role_id AND ro.code = 'manager'
       WHERE r.status = 'pending' AND r.branch_id = ${branchId} AND r.requester_id <> ${session.userId}
       ORDER BY ((r.payload->>'urgent') = 'true') DESC, r.created_at LIMIT 300`
    return {
      limit: APPROVAL_LIMIT,
      rows: rows.map((r) => ({ ...r, type_label: TYPE_LABEL[r.type] ?? r.type, over_limit: overLimit(r.type, r.amount), overdue: r.waiting_hours > 48 })),
    }
  })

  .get('/inbox/:id', async ({ params, session, branchId }) => {
    const p = await loadPending(params.id, session.userId, branchId)
    const [d, steps] = await Promise.all([
      buildDetail(p, branchId),
      sql`SELECT s.seq, ro.name AS role_name, s.status FROM platform.request_steps s JOIN platform.roles ro ON ro.id = s.approver_role_id
           WHERE s.request_id = ${p.id} ORDER BY s.seq`,
    ])
    return {
      id: p.id, request_no: p.request_no, type: p.type, type_label: TYPE_LABEL[p.type] ?? p.type, requester_name: p.requester_name, created_at: p.created_at,
      amount: p.amount, over_limit: overLimit(p.type, p.amount), limit: APPROVAL_LIMIT, steps, ...d,
    }
  }, { params: t.Object({ id: UUID }) })

  .post('/inbox/:id/approve', async ({ params, body, session, ip, branchId }) => {
    await approve(await loadPending(params.id, session.userId, branchId), { session, ip }, body)
    return { ok: true }
  }, { params: t.Object({ id: UUID }), body: Body })

  .post('/inbox/:id/forward', async ({ params, body, session, ip, branchId }) => {
    await forward(await loadPending(params.id, session.userId, branchId), { session, ip }, body.comment)
    return { ok: true }
  }, { params: t.Object({ id: UUID }), body: Body })

  .post('/inbox/:id/reject', async ({ params, body, session, ip, branchId }) => {
    await reject(await loadPending(params.id, session.userId, branchId), { session, ip }, body.comment ?? '')
    return { ok: true }
  }, { params: t.Object({ id: UUID }), body: Body })
