import { sql } from '../../../shared/db'
import type { Ctx } from './audit'
import { nextNo } from './docNo'

/**
 * หาผู้อนุมัติ (เรียงตามขั้น) จาก platform.approval_policies ที่ใช้งานอยู่และวงเงินตรงกับ amount
 * คืน role_id ที่ไม่ซ้ำ — ถ้าว่าง = ยังไม่ตั้งนโยบาย (ให้ผู้เรียก throw แจ้งให้ติดต่อ Admin)
 * ข้ามนโยบายที่มี condition_key (ใช้เฉพาะใบลาเกินสิทธิ์)
 */
export async function planSteps(types: string[], amount: number): Promise<string[]> {
  const rows = await sql`
    SELECT p.approver_role_id FROM platform.approval_policies p
     WHERE p.doc_type = ANY(${types}::text[]) AND p.active AND p.condition_key IS NULL
       AND ${amount}::numeric >= p.min_amount AND (p.max_amount IS NULL OR ${amount}::numeric <= p.max_amount)
     ORDER BY array_position(${types}::text[], p.doc_type), p.step_order`
  const out: string[] = []
  for (const r of rows) if (!out.includes(r.approver_role_id)) out.push(r.approver_role_id)
  return out
}

/** เตรียมคำสั่งสร้างคำขออนุมัติ + ขั้นอนุมัติ (ยังไม่รัน) — ขั้นแรก pending ที่เหลือ waiting */
export async function prepareRequest(
  ctx: Ctx,
  a: { type: string; amount: number; refTable: string; refId: string; payload: Record<string, unknown>; roleIds: string[]; branchId: string | null },
) {
  const id = crypto.randomUUID(), request_no = await nextNo('platform.requests', 'RQ')
  const seqs = a.roleIds.map((_, i) => i + 1)
  const queries = [
    sql`INSERT INTO platform.requests (id, request_no, type, requester_id, branch_id, amount, ref_table, ref_id, payload)
        VALUES (${id}, ${request_no}, ${a.type}, ${ctx.session.userId}, ${a.branchId}, ${a.amount}, ${a.refTable}, ${a.refId}, ${JSON.stringify(a.payload)}::jsonb)`,
    sql`INSERT INTO platform.request_steps (request_id, seq, approver_role_id, status)
        SELECT ${id}, s.seq, s.role_id, CASE WHEN s.seq = 1 THEN 'pending' ELSE 'waiting' END
          FROM unnest(${seqs}::int[], ${a.roleIds}::uuid[]) AS s(seq, role_id)`,
  ]
  return { id, request_no, queries }
}
