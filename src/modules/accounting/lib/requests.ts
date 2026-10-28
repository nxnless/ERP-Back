import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { ACCOUNTING_ROLES } from '../guard'
import { beYear } from './rules'

const LABEL: Record<string, string> = { PAYMENT: 'ขออนุมัติจ่ายเจ้าหนี้' }
const PREFIX: Record<string, string> = { PAYMENT: 'PAY' }

/** เลขที่คำขอ เช่น PAY-2569-0001 — ถ้าโปรเจคหลักมี sequence/ฟังก์ชันออกเลขคำขอแล้ว ให้แก้ที่ฟังก์ชันนี้ที่เดียว */
async function nextRequestNo(type: string) {
  const p = `${PREFIX[type] ?? type}-${beYear()}-`
  const [r] = await sql`SELECT count(*)::int + 1 AS n FROM platform.requests WHERE request_no LIKE ${p + '%'}`
  return p + String(r.n).padStart(4, '0')
}

/** สร้างคำขอ + ขั้นอนุมัติตาม platform.approval_policies (ยังไม่รัน) — ไม่มีนโยบายที่ตรงวงเงิน = ยื่นไม่ได้ */
export async function prepareRequest(a: { type: 'PAYMENT'; requesterId: string; payload: Record<string, unknown>; amount: number; ref: { table: string; id: string } }) {
  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM platform.approval_policies
     WHERE doc_type = ${a.type} AND active AND ${a.amount}::numeric >= min_amount AND (max_amount IS NULL OR ${a.amount}::numeric <= max_amount)`
  if (!n) throw new HttpError(409, `ยังไม่มีนโยบายอนุมัติสำหรับ "${LABEL[a.type]}" — แจ้ง Admin ตั้งค่าที่ Workflow อนุมัติก่อน`)
  const id = crypto.randomUUID(), request_no = await nextRequestNo(a.type)
  const queries = [
    sql`INSERT INTO platform.requests (id, request_no, type, requester_id, amount, ref_table, ref_id, status, payload)
        VALUES (${id}, ${request_no}, ${a.type}, ${a.requesterId}, ${a.amount}, ${a.ref.table}, ${a.ref.id}, 'pending', ${JSON.stringify(a.payload)}::jsonb)`,
    sql`INSERT INTO platform.request_steps (request_id, seq, approver_role_id, status)
        SELECT ${id}::uuid, p.step_order, p.approver_role_id, CASE WHEN p.step_order = min(p.step_order) OVER () THEN 'pending' ELSE 'waiting' END
          FROM platform.approval_policies p
         WHERE p.doc_type = ${a.type} AND p.active AND ${a.amount}::numeric >= p.min_amount AND (p.max_amount IS NULL OR ${a.amount}::numeric <= p.max_amount)`,
  ]
  return { id, request_no, queries }
}

export type Step = { id: string; request_no: string; requester_id: string; seq: number; status: string }

/** คำขอที่ขั้นปัจจุบันรอ "บทบาทบัญชี" ของผู้ใช้อยู่ — ทำแทนตัวเองไม่ได้ */
export async function pendingAccountingStep(requestId: string, type: string, session: { userId: string; roles: string[] }) {
  const roles = session.roles.filter((r) => ACCOUNTING_ROLES.includes(r))
  const [r] = await sql`
    SELECT r.id, r.request_no, r.requester_id, s.seq, r.status
      FROM platform.requests r JOIN platform.request_steps s ON s.request_id = r.id AND s.status = 'pending'
      JOIN platform.roles ro ON ro.id = s.approver_role_id AND ro.code = ANY(${roles}::text[])
     WHERE r.id = ${requestId} AND r.type = ${type} AND r.status = 'pending'`
  if (!r) throw new HttpError(404, 'ไม่พบคำขอที่รอฝ่ายบัญชีดำเนินการ')
  if (r.requester_id === session.userId) throw new HttpError(403, 'ดำเนินการคำขอของตนเองไม่ได้')
  return r as Step
}

/** อนุมัติขั้นของบัญชีแล้วเดินขั้นถัดไป (ไม่มีขั้นเหลือ = คำขอ approved) */
export const approveStep = (req: Step, userId: string, comment: string | null) => [
  sql`UPDATE platform.request_steps SET status = 'approved', approver_user_id = ${userId}, acted_at = now(), comment = ${comment}
       WHERE request_id = ${req.id} AND seq = ${req.seq} AND status = 'pending'`,
  sql`UPDATE platform.request_steps SET status = 'pending'
       WHERE request_id = ${req.id} AND seq = (SELECT min(seq) FROM platform.request_steps WHERE request_id = ${req.id} AND status = 'waiting')`,
  sql`UPDATE platform.requests SET status = 'approved', decided_at = now()
       WHERE id = ${req.id} AND NOT EXISTS (SELECT 1 FROM platform.request_steps WHERE request_id = ${req.id} AND status IN ('waiting','pending'))`,
]

/** ส่งกลับ: ปิดขั้นที่เหลือ และคำขอเป็น rejected พร้อมเหตุผล */
export const rejectStep = (req: Step, userId: string, reason: string) => [
  sql`UPDATE platform.request_steps SET status = 'rejected', approver_user_id = ${userId}, acted_at = now(), comment = ${reason}
       WHERE request_id = ${req.id} AND seq = ${req.seq} AND status = 'pending'`,
  sql`UPDATE platform.request_steps SET status = 'skipped' WHERE request_id = ${req.id} AND status = 'waiting'`,
  sql`UPDATE platform.requests SET status = 'rejected', decided_at = now() WHERE id = ${req.id}`,
]
