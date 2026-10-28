import { sql, HttpError } from '../deps'

export type RouteStep = { role_id: string; code: string; name: string }

/** สร้างเส้นทางอนุมัติจาก platform.approval_policies (Admin เป็นผู้ตั้งค่า) */
export async function resolveRoute(
  type: string,
  opt: { userId: string; amount?: number | null; payload?: Record<string, unknown> },
): Promise<RouteStep[]> {
  const amount = opt.amount ?? 0
  const rows = await sql`
    SELECT ap.condition_key, r.id AS role_id, r.code, r.name
      FROM platform.approval_policies ap JOIN platform.roles r ON r.id = ap.approver_role_id
     WHERE ap.doc_type = ${type} AND ap.active
       AND ${amount}::numeric >= ap.min_amount AND (ap.max_amount IS NULL OR ${amount}::numeric <= ap.max_amount)
     ORDER BY ap.step_order`
  const steps = rows.filter((r) => !r.condition_key || opt.payload?.[r.condition_key] === true)
  if (!steps.length) throw new HttpError(422, `ยังไม่ได้ตั้งนโยบายอนุมัติสำหรับ "${type}" — แจ้ง Admin ให้ตั้งค่าที่หน้า Workflow อนุมัติ`)

  // ผู้จัดการ/ผู้ตรวจสอบยื่นเอง → ขั้น "ผู้จัดการ" เปลี่ยนเป็นผู้บริหาร
  const mine = await sql`SELECT r.code FROM platform.user_roles ur JOIN platform.roles r ON r.id = ur.role_id WHERE ur.user_id = ${opt.userId}`
  if (mine.some((m) => m.code === 'manager' || m.code === 'auditor')) {
    const [exec] = await sql`SELECT id, code, name FROM platform.roles WHERE code = 'executive'`
    if (exec) return steps.map((s) => (s.code === 'manager' ? { role_id: exec.id, code: exec.code, name: exec.name } : { role_id: s.role_id, code: s.code, name: s.name }))
  }
  return steps.map((s) => ({ role_id: s.role_id, code: s.code, name: s.name }))
}

/** คำสั่ง INSERT คำขอ + ขั้นอนุมัติ (เอาไปรวมใน sql.transaction) */
export function insertRequest(p: {
  id: string; requestNo: string; type: string; userId: string; branchId: string | null
  amount?: number | null; refTable?: string; refId?: string; payload: Record<string, unknown>; steps: RouteStep[]
}) {
  return [
    sql`INSERT INTO platform.requests (id, request_no, type, requester_id, branch_id, amount, ref_table, ref_id, payload)
        VALUES (${p.id}, ${p.requestNo}, ${p.type}, ${p.userId}, ${p.branchId}, ${p.amount ?? null},
                ${p.refTable ?? null}, ${p.refId ?? null}, ${JSON.stringify(p.payload)}::jsonb)`,
    ...p.steps.map(
      (s, i) => sql`INSERT INTO platform.request_steps (request_id, seq, approver_role_id, status)
                    VALUES (${p.id}, ${i + 1}, ${s.role_id}, ${i === 0 ? 'pending' : 'waiting'})`,
    ),
  ]
}
