import { sql } from '../../../shared/db'
import type { Session } from '../../../auth/session'

export type Ctx = { session: Session; ip: string | null }

/**
 * คำสั่งบันทึก Audit Log (ยังไม่รัน) — ใส่ใน sql.transaction([...]) คู่กับการเปลี่ยนแปลง
 * เพื่อให้ "ตัดสินใจสำเร็จ = มี log" เสมอ  ห้ามใส่ข้อมูลส่วนตัว (เงินเดือนรายคน ฯลฯ) ใน before/after
 * module = โมดูลของเอกสาร (sales/purchasing/hr/payroll ...) ไม่ใช่ platform → Admin เห็นแค่ใคร/ทำอะไร/เมื่อไร
 */
export function audit(
  ctx: Ctx,
  a: { action: string; module: string; table: string; id?: string; ref?: string; before?: unknown; after?: unknown; risk?: 'low' | 'medium' | 'high' },
) {
  const j = (v: unknown) => (v == null ? null : JSON.stringify(v))
  return sql`
    INSERT INTO audit.audit_log (actor_id, actor_name, actor_roles, action, module, entity_table, entity_id, entity_ref, before, after, ip, risk)
    VALUES (${ctx.session.userId}, ${ctx.session.name}, ${ctx.session.roles.join(',')}, ${a.action}, ${a.module}, ${a.table},
            ${a.id ?? null}, ${a.ref ?? null}, ${j(a.before)}::jsonb, ${j(a.after)}::jsonb, ${ctx.ip}::inet, ${a.risk ?? 'low'})`
}
