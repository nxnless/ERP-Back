import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import type { Ctx } from './audit'
import { nextNo } from './docNo'

export type ApprovalType = 'PR' | 'PO' | 'SUPPLIER'

/**
 * เตรียมคำขออนุมัติ (ยังไม่รัน) ตามนโยบายที่ Admin ตั้งไว้ใน platform.approval_policies
 * — ขั้นที่วงเงินตรงกันจะถูกนำมาต่อกันตามลำดับ ขั้นแรก 'pending' ที่เหลือ 'waiting'
 * ไม่มีนโยบาย = ยื่นไม่ได้ (ตรงกับที่หน้า Overview/Workflow ของ Admin แจ้งไว้)
 * ใส่ queries ไว้ต้น sql.transaction([...]) เพราะเอกสารที่ตามมาอ้าง approval_request_id
 */
export async function prepareRequest(
  ctx: Ctx,
  a: { type: ApprovalType; amount: number; branchId?: string | null; refTable: string; refId: string; payload: Record<string, unknown> },
) {
  const route = await sql`
    SELECT p.step_order, p.approver_role_id, r.name AS role_name
      FROM platform.approval_policies p JOIN platform.roles r ON r.id = p.approver_role_id
     WHERE p.doc_type = ${a.type} AND p.active AND p.condition_key IS NULL
       AND ${a.amount}::numeric >= p.min_amount AND (p.max_amount IS NULL OR ${a.amount}::numeric <= p.max_amount)
     ORDER BY p.step_order`
  if (!route.length) throw new HttpError(422, `ยังไม่มีนโยบายอนุมัติสำหรับคำขอ ${a.type} ที่วงเงินนี้ — แจ้ง Admin ให้ตั้งค่าที่ "Workflow อนุมัติ"`)
  const id = crypto.randomUUID(), request_no = await nextNo('REQ')
  const queries = [
    sql`INSERT INTO platform.requests (id, request_no, type, requester_id, branch_id, amount, ref_table, ref_id, payload, status)
        VALUES (${id}, ${request_no}, ${a.type}, ${ctx.session.userId}, ${a.branchId ?? null}, ${a.amount}, ${a.refTable}, ${a.refId}, ${JSON.stringify(a.payload)}::jsonb, 'pending')`,
    sql`INSERT INTO platform.request_steps (request_id, seq, approver_role_id, status)
        SELECT ${id}::uuid, x.o::int, x.r, CASE WHEN x.o = 1 THEN 'pending' ELSE 'waiting' END
          FROM unnest(${route.map((r) => r.approver_role_id as string)}::uuid[]) WITH ORDINALITY AS x(r, o)`,
  ]
  return { id, request_no, route: route.map((r) => r.role_name as string), queries }
}
