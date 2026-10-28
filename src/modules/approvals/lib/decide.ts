import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { audit, type Ctx } from './audit'
import { ROLE_TYPES, TYPE_LABEL } from './rules'

type Req = { id: string; request_no: string; type: string; requester_id: string; amount: number | null; ref_id: string | null; seq: number; step_role: string }

/**
 * อัปเดตเอกสารต้นทางเมื่อคำขอ "จบ" (อนุมัติครบทุกขั้น หรือถูกปฏิเสธ) — รันใน transaction เดียวกับการตัดสิน
 * อนุมัติ: ทุกคำสั่งมีเงื่อนไขว่า platform.requests.status = 'approved' แล้วเท่านั้น (ยังมีขั้นถัดไป = ยังไม่แตะเอกสาร)
 * ปฏิเสธ: ส่งกลับผู้ยื่น — ใบเสนอราคากลับเป็น draft, PO ยกเลิกและเปิดใบขอซื้อให้ออก PO ใหม่ได้
 */
function syncQueries(req: Req, outcome: 'approved' | 'rejected') {
  const rid = req.id, ref = req.ref_id
  // neon sql`` ซ้อนกันไม่ได้ จึงเขียน EXISTS (คำขอจบแล้ว) ซ้ำในแต่ละคำสั่ง
  const done = outcome === 'approved'
  switch (req.type) {
    case 'PO':
      return done
        ? [sql`UPDATE purchasing.purchase_orders SET status = 'approved', updated_at = now() WHERE id = ${ref} AND status = 'pending_approval'
                 AND EXISTS (SELECT 1 FROM platform.requests WHERE id = ${rid} AND status = 'approved')`]
        : [sql`UPDATE purchasing.purchase_orders SET status = 'cancelled', updated_at = now() WHERE id = ${ref} AND status = 'pending_approval'
                 AND EXISTS (SELECT 1 FROM platform.requests WHERE id = ${rid} AND status = 'rejected')`,
           sql`UPDATE purchasing.purchase_requisitions SET status = 'approved', updated_at = now()
                WHERE status = 'po_issued' AND id = (SELECT pr_id FROM purchasing.purchase_orders WHERE id = ${ref})
                  AND EXISTS (SELECT 1 FROM platform.requests WHERE id = ${rid} AND status = 'rejected')`]
    case 'QUOTATION':
      return [sql`UPDATE sales.quotations SET status = ${done ? 'sent' : 'draft'}, updated_at = now() WHERE id = ${ref} AND status = 'pending_exec_approval'
                    AND EXISTS (SELECT 1 FROM platform.requests WHERE id = ${rid} AND status = ${outcome})`]
    case 'LEAVE':
      return done
        ? [sql`UPDATE hr.leave_requests SET status = 'approved' WHERE request_id = ${rid} AND status = 'pending'
                 AND EXISTS (SELECT 1 FROM platform.requests WHERE id = ${rid} AND status = 'approved')`,
           // ตัดสิทธิ์ลาในบัญชีแยกประเภท (เพิ่มได้อย่างเดียว) — กันซ้ำด้วย NOT EXISTS
           sql`INSERT INTO hr.leave_ledger (employee_id, leave_type_code, year, days, reason, ref_table, ref_id)
               SELECT lr.employee_id, lr.leave_type_code, extract(year FROM lr.start_date)::int, -lr.days, 'used', 'hr.leave_requests', lr.id
                 FROM hr.leave_requests lr WHERE lr.request_id = ${rid} AND lr.status = 'approved'
                  AND NOT EXISTS (SELECT 1 FROM hr.leave_ledger g WHERE g.ref_table = 'hr.leave_requests' AND g.ref_id = lr.id AND g.reason = 'used')`]
        : [sql`UPDATE hr.leave_requests SET status = 'rejected' WHERE request_id = ${rid} AND status = 'pending'
                 AND EXISTS (SELECT 1 FROM platform.requests WHERE id = ${rid} AND status = 'rejected')`]
    case 'OT':
      return [sql`UPDATE hr.ot_requests SET status = ${done ? 'approved' : 'rejected'} WHERE request_id = ${rid} AND status = 'pending'
                    AND EXISTS (SELECT 1 FROM platform.requests WHERE id = ${rid} AND status = ${outcome})`]
    case 'PR':
      return [sql`UPDATE purchasing.purchase_requisitions SET status = ${done ? 'approved' : 'rejected'}, updated_at = now() WHERE (id = ${ref} OR approval_request_id = ${rid}) AND status = 'pending_approval'
                    AND EXISTS (SELECT 1 FROM platform.requests WHERE id = ${rid} AND status = ${outcome})`] // ใบขอซื้อจากโมดูลอื่นอาจไม่ได้ใส่ ref_id จึงจับคู่ด้วย approval_request_id ด้วย
    case 'SUPPLIER':
      return [sql`UPDATE master.suppliers SET status = ${done ? 'approved' : 'suspended'} WHERE party_id = ${ref} AND status IN ('trial','pending')
                    AND EXISTS (SELECT 1 FROM platform.requests WHERE id = ${rid} AND status = ${outcome})`]
    default:
      return [] // HEADCOUNT: มีแต่ payload ไม่มีเอกสารต้นทาง
  }
}

export async function decide(ctx: Ctx, roles: string[], id: string, action: 'approve' | 'reject', commentIn?: string) {
  const [req] = await sql`
    SELECT r.id, r.request_no, r.type, r.requester_id, r.amount::float8 AS amount, r.ref_id, s.seq, ro.code AS step_role
      FROM platform.requests r JOIN platform.request_steps s ON s.request_id = r.id AND s.status = 'pending'
      JOIN platform.roles ro ON ro.id = s.approver_role_id AND ro.code = ANY(${roles}::text[])
     WHERE r.id = ${id} AND r.status = 'pending'` as unknown as Req[]
  if (!req) throw new HttpError(404, 'ไม่พบรายการที่รอคุณอนุมัติ (อาจถูกดำเนินการไปแล้ว)')
  if (req.requester_id === ctx.session.userId) throw new HttpError(403, 'อนุมัติคำขอของตนเองไม่ได้')
  if (!(ROLE_TYPES[req.step_role] ?? []).includes(req.type)) throw new HttpError(422, 'ประเภทคำขอนี้ยังไม่รองรับในกล่องอนุมัตินี้')
  const comment = (commentIn ?? '').trim(), uid = ctx.session.userId, rid = req.id
  if (action === 'reject' && !comment) throw new HttpError(422, 'ใส่เหตุผลที่ไม่อนุมัติก่อน')

  // คำสั่งหลังคำสั่งแรกมีเงื่อนไข "ขั้นนี้ถูกตัดสินโดยฉันในธุรกรรมนี้" (acted_at = now() คือเวลาเริ่มธุรกรรมเดียวกัน)
  // กันสองคนกดพร้อมกันแล้วขั้นถัดไปถูกเลื่อนซ้ำ
  if (action === 'approve') {
    await sql.transaction([
      sql`UPDATE platform.request_steps SET status = 'approved', approver_user_id = ${uid}, acted_at = now(), comment = ${comment || null}
           WHERE request_id = ${rid} AND seq = ${req.seq} AND status = 'pending'`,
      sql`UPDATE platform.request_steps SET status = 'pending'
           WHERE request_id = ${rid} AND seq = (SELECT min(seq) FROM platform.request_steps WHERE request_id = ${rid} AND status = 'waiting')
             AND EXISTS (SELECT 1 FROM platform.request_steps WHERE request_id = ${rid} AND seq = ${req.seq} AND status = 'approved' AND approver_user_id = ${uid} AND acted_at = now())`,
      sql`UPDATE platform.requests SET status = 'approved', decided_at = now()
           WHERE id = ${rid} AND status = 'pending' AND NOT EXISTS (SELECT 1 FROM platform.request_steps WHERE request_id = ${rid} AND status IN ('waiting','pending'))`,
      ...syncQueries(req, 'approved'),
      audit(ctx, { action: 'approve_request', table: 'platform.requests', id: rid, ref: req.request_no, risk: 'medium', after: { type: req.type, amount: req.amount, comment: comment || undefined } }),
    ])
  } else {
    await sql.transaction([
      sql`UPDATE platform.request_steps SET status = 'rejected', approver_user_id = ${uid}, acted_at = now(), comment = ${comment}
           WHERE request_id = ${rid} AND seq = ${req.seq} AND status = 'pending'`,
      sql`UPDATE platform.request_steps SET status = 'skipped' WHERE request_id = ${rid} AND status = 'waiting'
             AND EXISTS (SELECT 1 FROM platform.request_steps WHERE request_id = ${rid} AND seq = ${req.seq} AND status = 'rejected' AND approver_user_id = ${uid} AND acted_at = now())`,
      sql`UPDATE platform.requests SET status = 'rejected', decided_at = now()
           WHERE id = ${rid} AND status = 'pending'
             AND EXISTS (SELECT 1 FROM platform.request_steps WHERE request_id = ${rid} AND seq = ${req.seq} AND status = 'rejected' AND approver_user_id = ${uid} AND acted_at = now())`,
      ...syncQueries(req, 'rejected'),
      audit(ctx, { action: 'reject_request', table: 'platform.requests', id: rid, ref: req.request_no, risk: 'medium', after: { type: req.type, amount: req.amount, reason: comment } }),
    ])
  }
  const [after] = await sql`
    SELECT r.status, (SELECT ro.name FROM platform.request_steps s JOIN platform.roles ro ON ro.id = s.approver_role_id WHERE s.request_id = r.id AND s.status = 'pending') AS next_role
      FROM platform.requests r WHERE r.id = ${rid}`
  return { ok: true, type: req.type, type_label: TYPE_LABEL[req.type], request_no: req.request_no, status: after.status as string, next_role: (after.next_role as string | null) ?? null }
}
