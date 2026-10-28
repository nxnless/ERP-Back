import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { adminOnly } from '../guard'
import { audit } from '../lib/audit'
import { prepareUser } from '../lib/createUser'
import { UUID } from '../lib/rules'

/**
 * คำขอเปิดบัญชี (platform.requests ชนิด ACCOUNT ที่ HR ยื่น) — Admin ทำได้เฉพาะ "สร้างบัญชี/ปฏิเสธ" ไม่ใช่การอนุมัติธุรกรรม
 * payload ที่ HR ควรส่ง: { summary, name, email, position?, employee_id?, requested_role? }
 */
async function pendingRequest(id: string, adminId: string) {
  const [r] = await sql`
    SELECT r.id, r.request_no, r.requester_id, r.payload, s.seq
      FROM platform.requests r JOIN platform.request_steps s ON s.request_id = r.id AND s.status = 'pending'
      JOIN platform.roles ro ON ro.id = s.approver_role_id AND ro.code = 'admin'
     WHERE r.id = ${id} AND r.type = 'ACCOUNT' AND r.status = 'pending'`
  if (!r) throw new HttpError(404, 'ไม่พบคำขอที่รอดำเนินการ')
  if (r.requester_id === adminId) throw new HttpError(403, 'ดำเนินการคำขอของตนเองไม่ได้')
  return r as { id: string; request_no: string; requester_id: string; payload: Record<string, any>; seq: number }
}

export const accountRoutes = new Elysia()
  .use(adminOnly)
  .get('/account-requests', async () => await sql`
    SELECT r.id, r.request_no, r.payload, r.created_at, u.display_name AS requester_name
      FROM platform.requests r JOIN platform.users u ON u.id = r.requester_id
     WHERE r.type = 'ACCOUNT' AND r.status = 'pending'
       AND EXISTS (SELECT 1 FROM platform.request_steps s JOIN platform.roles ro ON ro.id = s.approver_role_id WHERE s.request_id = r.id AND s.status = 'pending' AND ro.code = 'admin')
     ORDER BY r.created_at`)

  // สร้างบัญชีตามคำขอ (Admin ตรวจ/แก้อีเมล ชื่อ บทบาท ก่อนกดยืนยัน) แล้วปิดขั้นนี้
  .post('/account-requests/:id/fulfill', async ({ params, body, session, ip }) => {
    const req = await pendingRequest(params.id, session.userId)
    const empId: string | undefined = body.employee_id ?? req.payload.employee_id ?? undefined
    if (empId) {
      const [e] = await sql`SELECT user_id FROM hr.employees WHERE id = ${empId}`
      if (!e) throw new HttpError(422, 'ไม่พบพนักงานตามที่ระบุ')
      if (e.user_id) throw new HttpError(409, 'พนักงานคนนี้มีบัญชีผู้ใช้อยู่แล้ว')
    }
    const ctx = { session, ip }
    const u = await prepareUser(body, ctx, `จากคำขอ ${req.request_no}`)
    await sql.transaction([
      ...u.queries,
      ...(empId ? [sql`UPDATE hr.employees SET user_id = ${u.id} WHERE id = ${empId} AND user_id IS NULL`] : []), // ผูกบัญชีกับทะเบียนพนักงาน (แก้เฉพาะ user_id)
      sql`UPDATE platform.request_steps SET status = 'approved', approver_user_id = ${session.userId}, acted_at = now(), comment = ${'สร้างบัญชีแล้ว: ' + u.email}
           WHERE request_id = ${req.id} AND seq = ${req.seq} AND status = 'pending'`,
      sql`UPDATE platform.request_steps SET status = 'pending'
           WHERE request_id = ${req.id} AND seq = (SELECT min(seq) FROM platform.request_steps WHERE request_id = ${req.id} AND status = 'waiting')`,
      sql`UPDATE platform.requests SET status = 'approved', decided_at = now()
           WHERE id = ${req.id} AND NOT EXISTS (SELECT 1 FROM platform.request_steps WHERE request_id = ${req.id} AND status IN ('waiting','pending'))`,
      audit(ctx, { action: 'fulfill_account_request', table: 'platform.requests', id: req.id, ref: req.request_no, after: { user: u.email, employee_linked: !!empId } }),
    ])
    return { id: u.id, email: u.email, temp_password: u.temp_password }
  }, { params: t.Object({ id: UUID }), body: t.Object({
      email: t.String({ pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', maxLength: 254 }), display_name: t.String({ minLength: 1, maxLength: 100 }),
      branch_id: t.Optional(UUID), role_ids: t.Array(UUID, { minItems: 1, maxItems: 10 }), employee_id: t.Optional(UUID),
  }) })

  .post('/account-requests/:id/reject', async ({ params, body, session, ip }) => {
    const req = await pendingRequest(params.id, session.userId)
    await sql.transaction([
      sql`UPDATE platform.request_steps SET status = 'rejected', approver_user_id = ${session.userId}, acted_at = now(), comment = ${body.reason.trim()}
           WHERE request_id = ${req.id} AND seq = ${req.seq} AND status = 'pending'`,
      sql`UPDATE platform.request_steps SET status = 'skipped' WHERE request_id = ${req.id} AND status = 'waiting'`,
      sql`UPDATE platform.requests SET status = 'rejected', decided_at = now() WHERE id = ${req.id}`,
      audit({ session, ip }, { action: 'reject_account_request', table: 'platform.requests', id: req.id, ref: req.request_no, after: { reason: body.reason.trim() } }),
    ])
    return { ok: true }
  }, { params: t.Object({ id: UUID }), body: t.Object({ reason: t.String({ minLength: 1, maxLength: 300 }) }) })
