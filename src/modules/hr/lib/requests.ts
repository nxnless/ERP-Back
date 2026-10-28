import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { beYear } from './rules'

const LABEL: Record<string, string> = { ACCOUNT: 'ขอเปิดบัญชีผู้ใช้', PAYROLL: 'รอบเงินเดือน' }
const PREFIX: Record<string, string> = { ACCOUNT: 'ACC', PAYROLL: 'PRL' }

/**
 * เลขที่คำขอ เช่น ACC-2569-0001 — ถ้าโปรเจคหลักมี sequence/ฟังก์ชันออกเลขคำขอแล้ว ให้แก้ที่ฟังก์ชันนี้ที่เดียว
 */
async function nextRequestNo(type: string) {
  const p = `${PREFIX[type] ?? type}-${beYear()}-`
  const [r] = await sql`SELECT count(*)::int + 1 AS n FROM platform.requests WHERE request_no LIKE ${p + '%'}`
  return p + String(r.n).padStart(4, '0')
}

/**
 * เตรียมคำสั่งสร้างคำขอ + ขั้นอนุมัติตาม platform.approval_policies (ยังไม่รัน) — ใส่ใน sql.transaction([...])
 * ขั้นแรกเป็น 'pending' ที่เหลือ 'waiting' (รูปแบบเดียวกับที่ admin/routes/accounts.ts เดินต่อ)
 * ไม่มีนโยบายที่ตรงวงเงิน = ยื่นไม่ได้ (ข้อความเดียวกับที่ Admin เห็นในหน้า "ภาพรวม")
 */
export async function prepareRequest(a: { type: 'ACCOUNT' | 'PAYROLL'; requesterId: string; payload: Record<string, unknown>; amount?: number; ref?: { table: string; id: string } }) {
  const amount = a.amount ?? 0
  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM platform.approval_policies
     WHERE doc_type = ${a.type} AND active AND ${amount}::numeric >= min_amount AND (max_amount IS NULL OR ${amount}::numeric <= max_amount)`
  if (!n) throw new HttpError(409, `ยังไม่มีนโยบายอนุมัติสำหรับ "${LABEL[a.type]}" — แจ้ง Admin ตั้งค่าที่ Workflow อนุมัติก่อน`)
  const id = crypto.randomUUID(), request_no = await nextRequestNo(a.type)
  const queries = [
    sql`INSERT INTO platform.requests (id, request_no, type, requester_id, amount, ref_table, ref_id, status, payload)
        VALUES (${id}, ${request_no}, ${a.type}, ${a.requesterId}, ${a.amount ?? null}, ${a.ref?.table ?? null}, ${a.ref?.id ?? null}, 'pending', ${JSON.stringify(a.payload)}::jsonb)`,
    sql`INSERT INTO platform.request_steps (request_id, seq, approver_role_id, status)
        SELECT ${id}::uuid, p.step_order, p.approver_role_id, CASE WHEN p.step_order = min(p.step_order) OVER () THEN 'pending' ELSE 'waiting' END
          FROM platform.approval_policies p
         WHERE p.doc_type = ${a.type} AND p.active AND ${amount}::numeric >= p.min_amount AND (p.max_amount IS NULL OR ${amount}::numeric <= p.max_amount)`,
  ]
  return { id, request_no, queries }
}

export type HrStep = { id: string; request_no: string; requester_id: string; payload: Record<string, any>; seq: number }

/** คำขอชนิด `type` ที่ขั้นปัจจุบันรอ "บทบาท hr" อยู่ — ทำแทนตัวเองไม่ได้ */
export async function pendingHrStep(id: string, type: string, userId: string) {
  const [r] = await sql`
    SELECT r.id, r.request_no, r.requester_id, r.payload, s.seq
      FROM platform.requests r JOIN platform.request_steps s ON s.request_id = r.id AND s.status = 'pending'
      JOIN platform.roles ro ON ro.id = s.approver_role_id AND ro.code = 'hr'
     WHERE r.id = ${id} AND r.type = ${type} AND r.status = 'pending'`
  if (!r) throw new HttpError(404, 'ไม่พบคำขอที่รอ HR ดำเนินการ')
  if (r.requester_id === userId) throw new HttpError(403, 'ดำเนินการคำขอของตนเองไม่ได้')
  return r as HrStep
}

/** อนุมัติขั้นของ HR แล้วเดินขั้นถัดไป (ถ้าไม่มีขั้นเหลือ คำขอเป็น approved) */
export const approveStep = (req: HrStep, userId: string, comment: string) => [
  sql`UPDATE platform.request_steps SET status = 'approved', approver_user_id = ${userId}, acted_at = now(), comment = ${comment}
       WHERE request_id = ${req.id} AND seq = ${req.seq} AND status = 'pending'`,
  sql`UPDATE platform.request_steps SET status = 'pending'
       WHERE request_id = ${req.id} AND seq = (SELECT min(seq) FROM platform.request_steps WHERE request_id = ${req.id} AND status = 'waiting')`,
  sql`UPDATE platform.requests SET status = 'approved', decided_at = now()
       WHERE id = ${req.id} AND NOT EXISTS (SELECT 1 FROM platform.request_steps WHERE request_id = ${req.id} AND status IN ('waiting','pending'))`,
]

/** ไม่อนุมัติ: ปิดขั้นที่เหลือ และคำขอเป็น rejected พร้อมเหตุผล */
export const rejectStep = (req: HrStep, userId: string, reason: string) => [
  sql`UPDATE platform.request_steps SET status = 'rejected', approver_user_id = ${userId}, acted_at = now(), comment = ${reason}
       WHERE request_id = ${req.id} AND seq = ${req.seq} AND status = 'pending'`,
  sql`UPDATE platform.request_steps SET status = 'skipped' WHERE request_id = ${req.id} AND status = 'waiting'`,
  sql`UPDATE platform.requests SET status = 'rejected', decided_at = now() WHERE id = ${req.id}`,
]
