import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { hashPassword } from '../../../auth/password'
import { adminOnly } from '../guard'
import { audit } from '../lib/audit'
import { prepareUser } from '../lib/createUser'
import { UUID, assertAdminsRemain, assertRoleCombo, rolesByIds, tempPassword } from '../lib/rules'

const EMAIL = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'

async function loadUser(id: string) {
  const [u] = await sql`
    SELECT u.id, u.email, u.display_name, u.status, u.branch_id,
           COALESCE(json_agg(json_build_object('id', r.id, 'code', r.code) ORDER BY r.code) FILTER (WHERE r.id IS NOT NULL), '[]'::json) AS roles
      FROM platform.users u LEFT JOIN platform.user_roles ur ON ur.user_id = u.id LEFT JOIN platform.roles r ON r.id = ur.role_id
     WHERE u.id = ${id} GROUP BY u.id`
  if (!u) throw new HttpError(404, 'ไม่พบผู้ใช้')
  return u as { id: string; email: string; display_name: string; status: string; branch_id: string | null; roles: { id: string; code: string }[] }
}

export const userRoutes = new Elysia()
  .use(adminOnly)
  // บทบาท + สาขา สำหรับฟอร์มผู้ใช้
  .get('/meta', async () => ({
    roles: await sql`SELECT id, code, name, is_system, can_approve FROM platform.roles ORDER BY is_system DESC, code`,
    branches: await sql`SELECT id, code, name FROM platform.branches WHERE active ORDER BY code`,
  }))
  .get(
    '/users',
    async ({ query }) => {
      const q = query.q?.trim() || null, status = query.status || null, role = query.role || null
      return sql`
        SELECT u.id, u.email, u.display_name, u.status, u.mfa_enabled, u.last_login_at, u.branch_id, b.name AS branch_name,
               COALESCE(json_agg(json_build_object('id', r.id, 'code', r.code, 'name', r.name) ORDER BY r.code) FILTER (WHERE r.id IS NOT NULL), '[]'::json) AS roles
          FROM platform.users u
          LEFT JOIN platform.branches b ON b.id = u.branch_id
          LEFT JOIN platform.user_roles ur ON ur.user_id = u.id LEFT JOIN platform.roles r ON r.id = ur.role_id
         WHERE (${q}::text IS NULL OR u.email ILIKE '%' || ${q} || '%' OR u.display_name ILIKE '%' || ${q} || '%')
           AND (${status}::text IS NULL OR u.status = ${status})
           AND (${role}::text IS NULL OR EXISTS (SELECT 1 FROM platform.user_roles x JOIN platform.roles y ON y.id = x.role_id WHERE x.user_id = u.id AND y.code = ${role}))
         GROUP BY u.id, b.name ORDER BY u.display_name LIMIT 500`
    },
    { query: t.Object({ q: t.Optional(t.String({ maxLength: 100 })), status: t.Optional(t.String()), role: t.Optional(t.String()) }) },
  )

  // เพิ่มผู้ใช้: สร้างบัญชีสถานะ active พร้อมรหัสผ่านชั่วคราว (ยังไม่มีระบบส่งอีเมลเชิญ — ส่งรหัสให้ผู้ใช้ทางช่องทางที่ปลอดภัยเอง)
  .post(
    '/users',
    async ({ body, session, ip }) => {
      const u = await prepareUser(body, { session, ip })
      await sql.transaction(u.queries)
      return { id: u.id, email: u.email, temp_password: u.temp_password }
    },
    { body: t.Object({ email: t.String({ pattern: EMAIL, maxLength: 254 }), display_name: t.String({ minLength: 1, maxLength: 100 }), branch_id: t.Optional(UUID), role_ids: t.Array(UUID, { minItems: 1, maxItems: 10 }) }) },
  )

  // เพิ่มผู้ใช้แบบเร็ว: อีเมล + ชื่อ + รหัสบทบาท (ไม่ระบุ = employee) → ได้รหัสผ่านชั่วคราวกลับมา
  // ใช้ prepareUser ตัวเดิม จึงได้กฎเดียวกับ POST /users ทุกข้อ (อีเมลซ้ำ, แยกหน้าที่ Admin, audit ในธุรกรรมเดียว)
  .post(
    '/users/quick',
    async ({ body, session, ip }) => {
      const [role] = await sql`SELECT id FROM platform.roles WHERE code = ${body.role ?? 'employee'}`
      if (!role) throw new HttpError(422, 'ไม่พบบทบาทตามรหัสที่ระบุ')
      const u = await prepareUser({ email: body.email, display_name: body.display_name, role_ids: [role.id] }, { session, ip }, 'เพิ่มแบบเร็ว')
      await sql.transaction(u.queries)
      return { id: u.id, email: u.email, temp_password: u.temp_password }
    },
    { body: t.Object({ email: t.String({ pattern: EMAIL, maxLength: 254 }), display_name: t.String({ minLength: 1, maxLength: 100 }), role: t.Optional(t.String({ pattern: '^[a-z][a-z0-9_]{1,30}$' })) }) },
  )

  .put(
    '/users/:id',
    async ({ params, body, session, ip }) => {
      const before = await loadUser(params.id)
      const roles = await rolesByIds(body.role_ids)
      const newCodes = roles.map((r) => r.code), oldCodes = before.roles.map((r) => r.code)
      const sameRoles = newCodes.length === oldCodes.length && newCodes.every((c) => oldCodes.includes(c))
      if (params.id === session.userId && !sameRoles) throw new HttpError(403, 'แก้บทบาทของตนเองไม่ได้ (ให้ Admin คนอื่นทำแทน)')
      assertRoleCombo(newCodes)
      if (oldCodes.includes('admin') && !newCodes.includes('admin') && before.status === 'active') await assertAdminsRemain(params.id)
      if (body.branch_id && !(await sql`SELECT 1 FROM platform.branches WHERE id = ${body.branch_id}`).length) throw new HttpError(422, 'ไม่พบสาขา')
      const ids = [...new Set(body.role_ids)]
      await sql.transaction([
        sql`UPDATE platform.users SET display_name = ${body.display_name.trim()}, branch_id = ${body.branch_id ?? null} WHERE id = ${params.id}`,
        sql`DELETE FROM platform.user_roles WHERE user_id = ${params.id} AND role_id <> ALL(${ids}::uuid[])`,
        sql`INSERT INTO platform.user_roles (user_id, role_id) SELECT ${params.id}, x FROM unnest(${ids}::uuid[]) AS x ON CONFLICT DO NOTHING`,
        audit({ session, ip }, { action: 'update_user', table: 'platform.users', id: params.id, ref: before.email,
          before: { display_name: before.display_name, branch_id: before.branch_id, roles: oldCodes },
          after: { display_name: body.display_name.trim(), branch_id: body.branch_id ?? null, roles: newCodes },
          risk: !sameRoles && (newCodes.includes('admin') || oldCodes.includes('admin')) ? 'high' : sameRoles ? 'low' : 'medium' }),
      ])
      return { ok: true }
    },
    { params: t.Object({ id: UUID }), body: t.Object({ display_name: t.String({ minLength: 1, maxLength: 100 }), branch_id: t.Optional(t.Union([UUID, t.Null()])), role_ids: t.Array(UUID, { minItems: 1, maxItems: 10 }) }) },
  )

  .post('/users/:id/suspend', async ({ params, session, ip }) => {
    const u = await loadUser(params.id)
    if (u.id === session.userId) throw new HttpError(403, 'ระงับบัญชีตนเองไม่ได้')
    if (u.status !== 'active') throw new HttpError(409, 'บัญชีนี้ไม่ได้อยู่ในสถานะใช้งาน')
    if (u.roles.some((r) => r.code === 'admin')) await assertAdminsRemain(u.id)
    await sql.transaction([
      sql`UPDATE platform.users SET status = 'suspended' WHERE id = ${u.id}`,
      audit({ session, ip }, { action: 'suspend_user', table: 'platform.users', id: u.id, ref: u.email, before: { status: u.status }, after: { status: 'suspended' }, risk: 'medium' }),
    ])
    return { ok: true } // token เดิมของผู้ใช้นี้ใช้ไม่ได้ทันที (backend ตรวจสถานะทุก request)
  }, { params: t.Object({ id: UUID }) })

  .post('/users/:id/reactivate', async ({ params, session, ip }) => {
    const u = await loadUser(params.id)
    if (u.status !== 'suspended') throw new HttpError(409, 'เปิดใช้ได้เฉพาะบัญชีที่ถูกระงับ')
    await sql.transaction([
      sql`UPDATE platform.users SET status = 'active' WHERE id = ${u.id}`,
      audit({ session, ip }, { action: 'reactivate_user', table: 'platform.users', id: u.id, ref: u.email, before: { status: 'suspended' }, after: { status: 'active' }, risk: 'medium' }),
    ])
    return { ok: true }
  }, { params: t.Object({ id: UUID }) })

  .post('/users/:id/reset-password', async ({ params, session, ip }) => {
    const u = await loadUser(params.id)
    if (u.id === session.userId) throw new HttpError(403, 'รีเซ็ตรหัสผ่านตนเองผ่านหน้านี้ไม่ได้')
    const pw = tempPassword()
    await sql.transaction([
      sql`UPDATE platform.users SET password_hash = ${await hashPassword(pw)} WHERE id = ${u.id}`,
      audit({ session, ip }, { action: 'reset_password', table: 'platform.users', id: u.id, ref: u.email, risk: 'medium' }),
    ])
    return { email: u.email, temp_password: pw }
  }, { params: t.Object({ id: UUID }) })