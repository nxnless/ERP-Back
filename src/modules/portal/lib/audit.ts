import { sql } from '../../../shared/db'

export type Ctx = { me: { id: string; name: string; partyName: string; kinds: string[] }; ip: string | null }

/**
 * คำสั่งบันทึก Audit Log (ยังไม่รัน) — ใส่ใน sql.transaction([...]) คู่กับการเปลี่ยนแปลง
 * module = 'portal' เสมอ → หน้า Audit ของ Admin เห็นแค่ใคร/ทำอะไร/เมื่อไร (ค่าก่อน–หลังถูกซ่อน)
 */
export function audit(
  ctx: Ctx,
  a: { action: string; table: string; id?: string; ref?: string; before?: unknown; after?: unknown; risk?: 'low' | 'medium' | 'high' },
) {
  const j = (v: unknown) => (v == null ? null : JSON.stringify(v))
  return sql`
    INSERT INTO audit.audit_log (actor_id, actor_name, actor_roles, action, module, entity_table, entity_id, entity_ref, before, after, ip, risk)
    VALUES (${ctx.me.id}, ${`${ctx.me.name} (${ctx.me.partyName})`}, ${'portal:' + ctx.me.kinds.join('+')}, ${a.action}, 'portal', ${a.table},
            ${a.id ?? null}, ${a.ref ?? null}, ${j(a.before)}::jsonb, ${j(a.after)}::jsonb, ${ctx.ip}::inet, ${a.risk ?? 'low'})`
}
