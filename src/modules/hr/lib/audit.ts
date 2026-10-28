import { sql } from '../../../shared/db'
import type { Session } from '../../../auth/session'

export type Ctx = { session: Session; ip: string | null }

/**
 * คำสั่งบันทึก Audit Log (ยังไม่รัน) — ใส่ใน sql.transaction([...]) คู่กับการเปลี่ยนแปลง
 * module = 'hr' | 'payroll' เสมอ (ไม่ใช่ 'platform') เพื่อให้ Admin เห็นแค่ว่าใครทำอะไรเมื่อไร ค่าก่อน–หลังถูกซ่อน
 * (ดู OPEN ใน admin/routes/audit.ts)  ห้ามใส่จำนวนเงินเดือนรายคนใน before/after
 */
export function audit(
  ctx: Ctx,
  a: { action: string; module?: 'hr' | 'payroll'; table: string; id?: string; ref?: string; before?: unknown; after?: unknown; risk?: 'low' | 'medium' | 'high' },
) {
  const j = (v: unknown) => (v == null ? null : JSON.stringify(v))
  return sql`
    INSERT INTO audit.audit_log (actor_id, actor_name, actor_roles, action, module, entity_table, entity_id, entity_ref, before, after, ip, risk)
    VALUES (${ctx.session.userId}, ${ctx.session.name}, ${ctx.session.roles.join(',')}, ${a.action}, ${a.module ?? 'hr'}, ${a.table},
            ${a.id ?? null}, ${a.ref ?? null}, ${j(a.before)}::jsonb, ${j(a.after)}::jsonb, ${ctx.ip}::inet, ${a.risk ?? 'low'})`
}
