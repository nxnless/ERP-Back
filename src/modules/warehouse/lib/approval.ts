import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { audit, type Ctx } from './audit'

/** ขั้นอนุมัติตามนโยบายที่ Admin ตั้งไว้ (platform.approval_policies) — ไม่มีนโยบาย = ยื่นไม่ได้ (ตรงกับที่หน้า Workflow แจ้งไว้) */
export async function approvalSteps(type: string, amount: number) {
  const rows = await sql`
    SELECT p.approver_role_id AS role FROM platform.approval_policies p
     WHERE p.doc_type = ${type} AND p.active AND p.condition_key IS NULL
       AND ${amount}::numeric >= p.min_amount AND (p.max_amount IS NULL OR ${amount}::numeric <= p.max_amount)
     ORDER BY p.step_order`
  if (!rows.length) throw new HttpError(409, `ยังไม่มีนโยบายอนุมัติสำหรับคำขอประเภท ${type} — แจ้งผู้ดูแลระบบให้ตั้งค่าที่ "Workflow อนุมัติ"`)
  return rows.map((r, i) => ({ seq: i + 1, role: r.role as string, status: i === 0 ? 'pending' : 'waiting' }))
}

/** คำสั่งสร้างคำขอ + ขั้นอนุมัติ (ยังไม่รัน) — ใส่ใน sql.transaction([...]) ร่วมกับการเปลี่ยนสถานะเอกสารต้นทาง */
export function requestQueries(
  ctx: Ctx,
  a: { type: string; requestNo: string; amount: number; branchId: string | null; refTable: string; refId: string; payload: Record<string, unknown> },
  steps: { seq: number; role: string; status: string }[],
) {
  const id = crypto.randomUUID()
  return {
    id,
    queries: [
      sql`INSERT INTO platform.requests (id, request_no, type, requester_id, branch_id, amount, ref_table, ref_id, payload)
          VALUES (${id}, ${a.requestNo}, ${a.type}, ${ctx.session.userId}, ${a.branchId}, ${a.amount}, ${a.refTable}, ${a.refId}, ${JSON.stringify(a.payload)}::jsonb)`,
      sql`INSERT INTO platform.request_steps (request_id, seq, approver_role_id, status)
          SELECT ${id}, x.seq, x.role::uuid, x.status FROM jsonb_to_recordset(${JSON.stringify(steps)}::jsonb) AS x(seq int, role text, status text)`,
      audit(ctx, { action: 'create_request', table: 'platform.requests', id, ref: a.requestNo, after: { type: a.type, ref: a.refTable } }),
    ],
  }
}
