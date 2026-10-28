import { sql } from '../../../shared/db'
import type { Session } from '../../../auth/session'

export type Ctx = { session: Session; ip: string | null }

/**
 * คำสั่งบันทึก Audit Log (ยังไม่รัน) — ใส่ใน sql.transaction([...]) คู่กับการเปลี่ยนแปลง
 * module = 'sales' | 'crm' เสมอ (ห้ามใช้ 'platform') เพราะหน้า Audit ของ Admin จะ "ซ่อนค่าก่อน–หลัง" ของโมดูลธุรกิจ
 * ห้ามใส่ข้อมูลอ่อนไหว (ต้นทุน/กำไร) ใน before/after
 */
export function audit(
  ctx: Ctx,
  a: { action: string; table: string; id?: string; ref?: string; before?: unknown; after?: unknown; risk?: 'low' | 'medium' | 'high'; module?: 'sales' | 'crm' },
) {
  const j = (v: unknown) => (v == null ? null : JSON.stringify(v))
  return sql`
    INSERT INTO audit.audit_log (actor_id, actor_name, actor_roles, action, module, entity_table, entity_id, entity_ref, before, after, ip, risk)
    VALUES (${ctx.session.userId}, ${ctx.session.name}, ${ctx.session.roles.join(',')}, ${a.action}, ${a.module ?? 'sales'}, ${a.table},
            ${a.id ?? null}, ${a.ref ?? null}, ${j(a.before)}::jsonb, ${j(a.after)}::jsonb, ${ctx.ip}::inet, ${a.risk ?? 'low'})`
}
