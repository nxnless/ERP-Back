import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { adminOnly } from '../guard'
import { audit } from '../lib/audit'
import { LEVELS, UUID } from '../lib/rules'

const PROTECTED_MODULES = ['settings', 'audit'] // ปิดไม่ได้ ไม่งั้น Admin จะเข้าตั้งค่า/ดู Audit Log ไม่ได้

async function loadRole(id: string) {
  const [r] = await sql`SELECT id, code, name, is_system, can_approve FROM platform.roles WHERE id = ${id}`
  if (!r) throw new HttpError(404, 'ไม่พบบทบาท')
  return r as { id: string; code: string; name: string; is_system: boolean; can_approve: boolean }
}

export const roleRoutes = new Elysia()
  .use(adminOnly)
  // ---------- โมดูล เปิด/ปิด ----------
  .get('/modules', async () => await sql`SELECT code, name, enabled FROM platform.modules ORDER BY code`)
  .put('/modules/:code', async ({ params, body, session, ip }) => {
    const [m] = await sql`SELECT code, name, enabled FROM platform.modules WHERE code = ${params.code}`
    if (!m) throw new HttpError(404, 'ไม่พบโมดูล')
    if (PROTECTED_MODULES.includes(m.code) && !body.enabled) throw new HttpError(403, `ปิดโมดูล "${m.name}" ไม่ได้`)
    await sql.transaction([
      sql`UPDATE platform.modules SET enabled = ${body.enabled} WHERE code = ${m.code}`,
      audit({ session, ip }, { action: body.enabled ? 'enable_module' : 'disable_module', table: 'platform.modules', ref: m.code, before: { enabled: m.enabled }, after: { enabled: body.enabled }, risk: 'medium' }),
    ])
    return { ok: true }
  }, { params: t.Object({ code: t.String() }), body: t.Object({ enabled: t.Boolean() }) })

  // ---------- บทบาทและสิทธิ์ ----------
  .get('/roles', async () => await sql`
    SELECT r.id, r.code, r.name, r.is_system, r.can_approve,
           (SELECT count(*)::int FROM platform.user_roles ur WHERE ur.role_id = r.id) AS user_count,
           COALESCE((SELECT json_object_agg(a.module_code, a.level) FROM platform.role_module_access a WHERE a.role_id = r.id), '{}'::json) AS access
      FROM platform.roles r ORDER BY r.is_system DESC, r.code`)

  .post('/roles', async ({ body, session, ip }) => {
    if ((await sql`SELECT 1 FROM platform.roles WHERE code = ${body.code}`).length) throw new HttpError(409, 'รหัสบทบาทนี้มีอยู่แล้ว')
    const id = crypto.randomUUID()
    await sql.transaction([
      sql`INSERT INTO platform.roles (id, code, name, is_system, can_approve) VALUES (${id}, ${body.code}, ${body.name.trim()}, false, ${body.can_approve ?? false})`,
      audit({ session, ip }, { action: 'create_role', table: 'platform.roles', id, ref: body.code, after: { name: body.name.trim(), can_approve: body.can_approve ?? false } }),
    ])
    return { id }
  }, { body: t.Object({ code: t.String({ pattern: '^[a-z][a-z0-9_]{2,30}$' }), name: t.String({ minLength: 1, maxLength: 60 }), can_approve: t.Optional(t.Boolean()) }) })

  .put('/roles/:id', async ({ params, body, session, ip }) => {
    const r = await loadRole(params.id)
    if (r.code === 'admin') throw new HttpError(403, 'บทบาทผู้ดูแลระบบแก้ไขไม่ได้ (ล็อกไว้ ห้ามเป็นผู้อนุมัติธุรกรรม)')
    if (r.can_approve && !body.can_approve) {
      const [p] = await sql`SELECT count(*)::int AS n FROM platform.approval_policies WHERE approver_role_id = ${r.id} AND active`
      if (p.n > 0) throw new HttpError(409, `บทบาทนี้ยังเป็นผู้อนุมัติอยู่ใน ${p.n} นโยบาย — ย้ายนโยบายออกก่อน`)
    }
    await sql.transaction([
      sql`UPDATE platform.roles SET name = ${body.name.trim()}, can_approve = ${body.can_approve} WHERE id = ${r.id}`,
      audit({ session, ip }, { action: 'update_role', table: 'platform.roles', id: r.id, ref: r.code, before: { name: r.name, can_approve: r.can_approve }, after: { name: body.name.trim(), can_approve: body.can_approve }, risk: r.can_approve !== body.can_approve ? 'medium' : 'low' }),
    ])
    return { ok: true }
  }, { params: t.Object({ id: UUID }), body: t.Object({ name: t.String({ minLength: 1, maxLength: 60 }), can_approve: t.Boolean() }) })

  // ตั้งสิทธิ์รายโมดูลของบทบาท (none < read < write < manage) — แทนที่ทั้งชุด
  .put('/roles/:id/access', async ({ params, body, session, ip }) => {
    const r = await loadRole(params.id)
    if (r.code === 'admin') throw new HttpError(403, 'สิทธิ์ของผู้ดูแลระบบล็อกไว้ (ตั้งค่าระบบ + ดู Audit เท่านั้น ไม่เห็นข้อมูลธุรกิจ)')
    const mods = (await sql`SELECT code FROM platform.modules`).map((m) => m.code as string)
    for (const [m, level] of Object.entries(body.access)) {
      if (!mods.includes(m)) throw new HttpError(422, `ไม่พบโมดูล ${m}`)
      if (!(LEVELS as readonly string[]).includes(level)) throw new HttpError(422, `ระดับสิทธิ์ไม่ถูกต้อง: ${level}`)
      if (m === 'settings' && level !== 'none') throw new HttpError(422, 'สิทธิ์ "ตั้งค่าระบบ" มอบให้ได้เฉพาะผู้ดูแลระบบ')
    }
    const [{ access: before }] = await sql`SELECT COALESCE(json_object_agg(module_code, level), '{}'::json) AS access FROM platform.role_module_access WHERE role_id = ${r.id}`
    const after = Object.fromEntries(Object.entries(body.access).filter(([, l]) => l !== 'none'))
    await sql.transaction([
      sql`DELETE FROM platform.role_module_access WHERE role_id = ${r.id}`,
      sql`INSERT INTO platform.role_module_access (role_id, module_code, level)
          SELECT ${r.id}, key, value FROM jsonb_each_text(${JSON.stringify(after)}::jsonb) WHERE value <> 'none'`,
      audit({ session, ip }, { action: 'update_role_access', table: 'platform.role_module_access', id: r.id, ref: r.code, before, after, risk: 'medium' }),
    ])
    return { ok: true }
  }, { params: t.Object({ id: UUID }), body: t.Object({ access: t.Record(t.String(), t.String()) }) })

  .delete('/roles/:id', async ({ params, session, ip }) => {
    const r = await loadRole(params.id)
    if (r.is_system) throw new HttpError(403, 'ลบบทบาทของระบบไม่ได้')
    const [u] = await sql`SELECT (SELECT count(*)::int FROM platform.user_roles WHERE role_id = ${r.id}) AS users, (SELECT count(*)::int FROM platform.approval_policies WHERE approver_role_id = ${r.id}) AS policies`
    if (u.users) throw new HttpError(409, `ยังมีผู้ใช้ ${u.users} คนใช้บทบาทนี้อยู่`)
    if (u.policies) throw new HttpError(409, `ยังเป็นผู้อนุมัติอยู่ใน ${u.policies} นโยบาย`)
    await sql.transaction([
      sql`DELETE FROM platform.roles WHERE id = ${r.id}`,
      audit({ session, ip }, { action: 'delete_role', table: 'platform.roles', id: r.id, ref: r.code, before: { name: r.name }, risk: 'medium' }),
    ])
    return { ok: true }
  }, { params: t.Object({ id: UUID }) })
