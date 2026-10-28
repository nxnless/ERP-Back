import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { hrOnly, moduleAccess } from '../guard'
import { audit } from '../lib/audit'
import { finalizeApproved, finalizeRejected, loadLeave } from '../lib/leave'
import { approveStep, pendingHrStep, rejectStep } from '../lib/requests'
import { UUID } from '../lib/rules'

/**
 * ใบลา = hr.leave_requests ที่ผูกกับ platform.requests (type LEAVE) ผ่าน request_id
 * ระบบตั้งธง over_quota / cert_missing ไว้แล้วตอนยื่น — HR เห็นเป็นขั้นอนุมัติเฉพาะใบที่นโยบาย Workflow ส่งมาให้บทบาท hr
 */
export const leaveRoutes = new Elysia()
  .use(hrOnly)
  .get('/leave/pending-count', async () => {
    const [r] = await sql`
      SELECT count(*)::int AS count FROM platform.requests r
       WHERE r.type = 'LEAVE' AND r.status = 'pending'
         AND EXISTS (SELECT 1 FROM platform.request_steps s JOIN platform.roles ro ON ro.id = s.approver_role_id
                      WHERE s.request_id = r.id AND s.status = 'pending' AND ro.code = 'hr')`
    return r
  }, { beforeHandle: moduleAccess('hr', 'read') })

  // ใบลาที่รออยู่ + ที่ตัดสินแล้วใน 30 วัน (เรียงใบที่รอ HR ขึ้นก่อน) พร้อมผลตรวจสิทธิ์/เอกสาร
  .get('/leave/requests', async () => {
    const rows = await sql`
      SELECT lr.id, lr.doc_no, lr.start_date, lr.end_date, lr.days::float8 AS days, lr.certificate_attached, lr.over_quota, lr.cert_missing,
             lr.status AS leave_status, lr.created_at, e.code AS employee_no, e.full_name AS employee_name, lt.name AS type_name,
             COALESCE(lt.cert_required_from_days, 0)::float8 AS cert_after_days,
             COALESCE((SELECT sum(l.days) FROM hr.leave_ledger l WHERE l.employee_id = lr.employee_id AND l.leave_type_code = lr.leave_type_code
                          AND l.year = extract(year FROM lr.start_date)::int), 0)::float8 AS balance,
             ps.role_code AS awaiting_role, ps.role_name AS awaiting_name, rs.role_code AS rejected_by_role
        FROM hr.leave_requests lr
        JOIN hr.employees e ON e.id = lr.employee_id
        JOIN hr.leave_types lt ON lt.code = lr.leave_type_code
        LEFT JOIN platform.requests rq ON rq.id = lr.request_id
        LEFT JOIN LATERAL (SELECT ro.code AS role_code, ro.name AS role_name FROM platform.request_steps s JOIN platform.roles ro ON ro.id = s.approver_role_id
                            WHERE s.request_id = lr.request_id AND s.status = 'pending' ORDER BY s.seq LIMIT 1) ps ON true
        LEFT JOIN LATERAL (SELECT ro.code AS role_code FROM platform.request_steps s JOIN platform.roles ro ON ro.id = s.approver_role_id
                            WHERE s.request_id = lr.request_id AND s.status = 'rejected' LIMIT 1) rs ON true
       WHERE lr.status = 'pending' OR rq.decided_at >= now() - interval '30 days'
       ORDER BY (ps.role_code = 'hr') DESC NULLS LAST, lr.created_at DESC LIMIT 200`
    return rows.map((r) => {
      const status = r.leave_status === 'pending' ? (r.awaiting_role === 'hr' ? 'pending_hr' : 'pending_other')
        : r.leave_status === 'approved' ? 'approved' : r.leave_status === 'cancelled' ? 'cancelled' : r.rejected_by_role === 'hr' ? 'rejected_hr' : 'rejected'
      return {
        id: r.id, request_no: r.doc_no, employee_name: r.employee_name, employee_no: r.employee_no, type_name: r.type_name,
        start_date: r.start_date, end_date: r.end_date, days: r.days, balance: r.balance, status, awaiting: r.awaiting_name ?? null, created_at: r.created_at,
        checks: { balanceOk: !r.over_quota, certRequired: r.cert_after_days > 0 && r.days >= r.cert_after_days, certOk: !r.cert_missing },
      }
    })
  }, { beforeHandle: moduleAccess('hr', 'read') })

  .post('/leave/requests/:id/approve', async ({ params, session, ip }) => {
    const lr = await loadLeave(params.id)
    const req = await pendingHrStep(lr.request_id, 'LEAVE', session.userId)
    await sql.transaction([
      ...approveStep(req, session.userId, 'HR อนุมัติเป็นกรณียกเว้น'),
      ...finalizeApproved(lr.id),
      audit({ session, ip }, { action: 'approve_leave_exception', table: 'hr.leave_requests', id: lr.id, ref: lr.doc_no, risk: 'medium' }),
    ])
    return { ok: true }
  }, { beforeHandle: moduleAccess('hr', 'write'), params: t.Object({ id: UUID }) })

  .post('/leave/requests/:id/reject', async ({ params, body, session, ip }) => {
    const reason = body.reason.trim()
    if (!reason) throw new HttpError(422, 'ต้องระบุเหตุผลที่ไม่อนุมัติ')
    const lr = await loadLeave(params.id)
    const req = await pendingHrStep(lr.request_id, 'LEAVE', session.userId)
    await sql.transaction([
      ...rejectStep(req, session.userId, reason),
      ...finalizeRejected(lr.id),
      audit({ session, ip }, { action: 'reject_leave', table: 'hr.leave_requests', id: lr.id, ref: lr.doc_no, after: { reason }, risk: 'medium' }),
    ])
    return { ok: true }
  }, { beforeHandle: moduleAccess('hr', 'write'), params: t.Object({ id: UUID }), body: t.Object({ reason: t.String({ minLength: 1, maxLength: 300 }) }) })

  // ---------- นโยบายลา (hr.leave_types) ----------
  .get('/leave/policies', async () => await sql`
    SELECT code AS leave_type, name, annual_days::float8 AS annual_days, carry_over_days::float8 AS carry_days, notice_days,
           COALESCE(cert_required_from_days, 0)::float8 AS cert_after_days, statutory
      FROM hr.leave_types ORDER BY CASE code WHEN 'vacation' THEN 1 WHEN 'sick' THEN 2 WHEN 'personal' THEN 3 WHEN 'maternity' THEN 4 ELSE 9 END, code`,
    { beforeHandle: moduleAccess('hr', 'read') })

  // แก้ได้ทีละช่อง มีผลกับใบลาใหม่ · ประเภทที่กฎหมายกำหนด (ลาคลอด) ล็อกไว้ · cert_after_days = 0 หมายถึงไม่ต้องแนบ
  .put('/leave/policies/:type', async ({ params, body, session, ip }) => {
    const [old] = await sql`
      SELECT name, statutory, annual_days::float8 AS annual_days, carry_over_days::float8 AS carry_days, notice_days, COALESCE(cert_required_from_days, 0)::float8 AS cert_after_days
        FROM hr.leave_types WHERE code = ${params.type}`
    if (!old) throw new HttpError(404, 'ไม่พบประเภทการลา')
    if (old.statutory) throw new HttpError(403, `${old.name} กำหนดตามกฎหมาย แก้ไขไม่ได้`)
    const n = (v?: number) => v ?? null
    const [after] = await sql`
      UPDATE hr.leave_types SET annual_days = COALESCE(${n(body.annual_days)}::numeric, annual_days), carry_over_days = COALESCE(${n(body.carry_days)}::numeric, carry_over_days),
             notice_days = COALESCE(${n(body.notice_days)}::int, notice_days),
             cert_required_from_days = CASE WHEN ${n(body.cert_after_days)}::numeric IS NULL THEN cert_required_from_days
                                            WHEN ${n(body.cert_after_days)}::numeric = 0 THEN NULL ELSE ${n(body.cert_after_days)}::numeric END
       WHERE code = ${params.type} AND NOT statutory
   RETURNING annual_days::float8 AS annual_days, carry_over_days::float8 AS carry_days, notice_days, COALESCE(cert_required_from_days, 0)::float8 AS cert_after_days`
    const { name: _n, statutory: _s, ...before } = old
    await audit({ session, ip }, { action: 'update_leave_policy', table: 'hr.leave_types', ref: params.type, before, after, risk: 'medium' })
    return after
  }, {
    beforeHandle: moduleAccess('hr', 'write'), params: t.Object({ type: t.String() }),
    body: t.Object({ annual_days: t.Optional(t.Number({ minimum: 0, maximum: 365 })), carry_days: t.Optional(t.Number({ minimum: 0, maximum: 365 })),
      notice_days: t.Optional(t.Integer({ minimum: 0, maximum: 365 })), cert_after_days: t.Optional(t.Number({ minimum: 0, maximum: 365 })) }),
  })
