import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'

/** ใบลา (hr.leave_requests) → เลขคำขอใน platform.requests ที่เดินขั้นอนุมัติอยู่ */
export async function loadLeave(id: string) {
  const [l] = await sql`SELECT id, doc_no, request_id, status FROM hr.leave_requests WHERE id = ${id}`
  if (!l) throw new HttpError(404, 'ไม่พบใบลา')
  if (!l.request_id) throw new HttpError(409, 'ใบลานี้ยังไม่ได้เข้าขั้นตอนอนุมัติ')
  return l as { id: string; doc_no: string; request_id: string; status: string }
}

/**
 * เมื่อ HR กดอนุมัติเป็นขั้นสุดท้าย คำขอใน platform.requests กลายเป็น approved — ต้องซิงก์ใบลาและตัดสิทธิ์ด้วย
 * (ทำเฉพาะเมื่อคำขอ approved แล้วจริง และตัดสิทธิ์ซ้ำไม่ได้)
 * สมมติ: hr.leave_ledger เก็บ 'used' เป็นค่าติดลบ และยอดคงเหลือ = ผลรวม days ของปี/ประเภทนั้น
 * ถ้าโมดูล employee มีฟังก์ชันปิดใบลาอยู่แล้ว ให้เรียกใช้แทนที่ฟังก์ชันนี้
 */
export const finalizeApproved = (leaveId: string) => [
  sql`UPDATE hr.leave_requests lr SET status = 'approved'
       WHERE lr.id = ${leaveId} AND lr.status = 'pending' AND EXISTS (SELECT 1 FROM platform.requests r WHERE r.id = lr.request_id AND r.status = 'approved')`,
  sql`INSERT INTO hr.leave_ledger (employee_id, leave_type_code, year, days, reason, ref_table, ref_id)
      SELECT lr.employee_id, lr.leave_type_code, extract(year FROM lr.start_date)::int, -lr.days, 'used', 'hr.leave_requests', lr.id
        FROM hr.leave_requests lr
       WHERE lr.id = ${leaveId} AND lr.status = 'approved'
         AND NOT EXISTS (SELECT 1 FROM hr.leave_ledger l WHERE l.ref_table = 'hr.leave_requests' AND l.ref_id = lr.id AND l.reason = 'used')`,
]

export const finalizeRejected = (leaveId: string) => [sql`UPDATE hr.leave_requests SET status = 'rejected' WHERE id = ${leaveId} AND status = 'pending'`]
