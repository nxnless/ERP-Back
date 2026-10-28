import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { audit, type Ctx } from './audit'
import { onApproved, onRejected } from './finalize'
import { APPROVAL_LIMIT, MODULE_OF, overLimit } from './rules'
import { fm } from './util'

export type Pending = {
  id: string; request_no: string; type: string; requester_id: string; requester_name: string; created_at: string
  amount: number | null; ref_table: string | null; ref_id: string | null; payload: Record<string, any>; seq: number
}

/** คำขอที่ "ขั้นปัจจุบันรอผู้จัดการ" ในสาขาของผู้จัดการ — ไม่ใช่ = 404 · ของตนเอง = 403 */
export async function loadPending(id: string, userId: string, branchId: string): Promise<Pending> {
  const [r] = await sql`
    SELECT r.id, r.request_no, r.type, r.requester_id, u.display_name AS requester_name, r.created_at, r.amount::float8 AS amount,
           r.ref_table, r.ref_id, r.payload, s.seq
      FROM platform.requests r
      JOIN platform.users u ON u.id = r.requester_id
      JOIN platform.request_steps s ON s.request_id = r.id AND s.status = 'pending'
      JOIN platform.roles ro ON ro.id = s.approver_role_id AND ro.code = 'manager'
     WHERE r.id = ${id} AND r.status = 'pending' AND r.branch_id = ${branchId}`
  if (!r) throw new HttpError(404, 'ไม่พบคำขอที่รอดำเนินการ')
  if (r.requester_id === userId) throw new HttpError(403, 'อนุมัติคำขอของตนเองไม่ได้')
  return r as Pending
}

/** รอบเงินเดือน: ต้องผ่านบัญชีตรวจแล้ว + รายการผิดปกติยืนยันครบ + ผู้จัดการติ๊กยืนยัน */
async function assertPayrollReady(p: Pending, confirm?: boolean) {
  if (!confirm) throw new HttpError(422, 'ต้องยืนยันว่าตรวจสอบยอดรวมและรายการผิดปกติแล้วก่อนอนุมัติ')
  if (p.ref_table !== 'hr.payroll_runs' || !p.ref_id) throw new HttpError(409, 'คำขอนี้ไม่ได้ผูกกับรอบเงินเดือน')
  const [run] = await sql`
    SELECT status, (SELECT count(*)::int FROM hr.payroll_exceptions x WHERE x.run_id = ${p.ref_id} AND x.confirmed_at IS NULL) AS open_exc
      FROM hr.payroll_runs WHERE id = ${p.ref_id}`
  if (!run) throw new HttpError(404, 'ไม่พบรอบเงินเดือน')
  if (run.status !== 'accounting_checked') throw new HttpError(409, 'รอบเงินเดือนยังไม่ผ่านการตรวจของบัญชี')
  if (run.open_exc > 0) throw new HttpError(409, `ยังมีรายการผิดปกติที่ HR ไม่ได้ยืนยัน ${run.open_exc} รายการ`)
}

const risk = (p: Pending) => (p.type === 'PAYROLL' ? 'high' : (p.amount ?? 0) >= APPROVAL_LIMIT / 2 ? 'medium' : 'low') as 'low' | 'medium' | 'high'
const base = (p: Pending) => ({ module: MODULE_OF[p.type] ?? 'platform', table: 'platform.requests', id: p.id, ref: p.request_no })

export async function approve(p: Pending, ctx: Ctx, body: { comment?: string; confirm?: boolean }) {
  if (overLimit(p.type, p.amount)) throw new HttpError(403, `เกินวงเงินอนุมัติ ${fm(APPROVAL_LIMIT)} บาท — ใช้ "ส่งต่อผู้บริหาร"`)
  if (p.type === 'PAYROLL') await assertPayrollReady(p, body.confirm)
  const note = body.comment?.trim() || null
  await sql.transaction([
    sql`UPDATE platform.request_steps SET status = 'approved', approver_user_id = ${ctx.session.userId}, acted_at = now(), comment = ${note}
         WHERE request_id = ${p.id} AND seq = ${p.seq} AND status = 'pending'`,
    sql`UPDATE platform.request_steps SET status = 'pending'
         WHERE request_id = ${p.id} AND seq = (SELECT min(seq) FROM platform.request_steps WHERE request_id = ${p.id} AND status = 'waiting')`,
    sql`UPDATE platform.requests SET status = 'approved', decided_at = now()
         WHERE id = ${p.id} AND NOT EXISTS (SELECT 1 FROM platform.request_steps WHERE request_id = ${p.id} AND status IN ('waiting','pending'))`,
    ...onApproved(p),
    audit(ctx, { ...base(p), action: 'approve_request', after: { type: p.type, amount: p.amount, comment: note }, risk: risk(p) }),
  ])
}

export async function reject(p: Pending, ctx: Ctx, reason: string) {
  const why = reason.trim()
  if (!why) throw new HttpError(422, 'ต้องระบุเหตุผลที่ไม่อนุมัติ')
  await sql.transaction([
    sql`UPDATE platform.request_steps SET status = 'rejected', approver_user_id = ${ctx.session.userId}, acted_at = now(), comment = ${why}
         WHERE request_id = ${p.id} AND seq = ${p.seq} AND status = 'pending'`,
    sql`UPDATE platform.request_steps SET status = 'skipped' WHERE request_id = ${p.id} AND status = 'waiting'`,
    sql`UPDATE platform.requests SET status = 'rejected', decided_at = now() WHERE id = ${p.id}`,
    ...onRejected(p),
    audit(ctx, { ...base(p), action: 'reject_request', after: { type: p.type, amount: p.amount, reason: why }, risk: 'low' }),
  ])
}

/**
 * ส่งต่อผู้บริหาร (เฉพาะรายการเกินวงเงิน): ขั้นของผู้จัดการถูกข้าม ไม่นับเป็นอนุมัติ
 * - ขั้นถัดไปเป็นผู้บริหารอยู่แล้ว → เลื่อนขั้นนั้นขึ้นมารอ
 * - ไม่มีขั้นถัดไป → เพิ่มขั้นผู้บริหารต่อท้าย
 * - ขั้นถัดไปเป็นบทบาทอื่น → ไม่ทำเอง (409) ให้ Admin แก้นโยบายที่หน้า Workflow
 */
export async function forward(p: Pending, ctx: Ctx, comment?: string) {
  if (!overLimit(p.type, p.amount)) throw new HttpError(409, 'รายการนี้อยู่ในวงเงินของคุณ — อนุมัติหรือไม่อนุมัติได้เลย')
  const [exec] = await sql`SELECT id FROM platform.roles WHERE code = 'executive'`
  if (!exec) throw new HttpError(409, 'ยังไม่มีบทบาทผู้บริหารในระบบ')
  const [next] = await sql`SELECT seq, approver_role_id FROM platform.request_steps WHERE request_id = ${p.id} AND status = 'waiting' ORDER BY seq LIMIT 1`
  if (next && next.approver_role_id !== exec.id) throw new HttpError(409, 'ขั้นถัดไปของคำขอนี้ไม่ใช่ผู้บริหาร — ให้ผู้ดูแลระบบปรับนโยบายอนุมัติ')
  const note = `ส่งต่อผู้บริหาร (เกินวงเงิน ${fm(APPROVAL_LIMIT)} บาท)` + (comment?.trim() ? ` · ${comment.trim()}` : '')
  await sql.transaction([
    sql`UPDATE platform.request_steps SET status = 'skipped', approver_user_id = ${ctx.session.userId}, acted_at = now(), comment = ${note}
         WHERE request_id = ${p.id} AND seq = ${p.seq} AND status = 'pending'`,
    next
      ? sql`UPDATE platform.request_steps SET status = 'pending' WHERE request_id = ${p.id} AND seq = ${next.seq} AND status = 'waiting'`
      : sql`INSERT INTO platform.request_steps (request_id, seq, approver_role_id, status)
            SELECT ${p.id}, max(seq) + 1, ${exec.id}, 'pending' FROM platform.request_steps WHERE request_id = ${p.id}`,
    audit(ctx, { ...base(p), action: 'forward_request', after: { type: p.type, amount: p.amount, to: 'executive' }, risk: 'medium' }),
  ])
}
