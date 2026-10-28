import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { hashPassword } from '../../../auth/password'
import { audit, type Ctx } from './audit'
import { assertRoleCombo, rolesByIds, tempPassword } from './rules'

/** เตรียมคำสั่งสร้างผู้ใช้ + บทบาท + audit (ยังไม่รัน) — ใช้ร่วมกันระหว่าง "เพิ่มผู้ใช้" และ "ดำเนินการคำขอเปิดบัญชี" */
export async function prepareUser(
  body: { email: string; display_name: string; branch_id?: string | null; role_ids: string[] },
  ctx: Ctx,
  note?: string,
) {
  const email = body.email.trim().toLowerCase()
  const roles = await rolesByIds(body.role_ids)
  assertRoleCombo(roles.map((r) => r.code))
  if ((await sql`SELECT 1 FROM platform.users WHERE lower(email) = ${email}`).length) throw new HttpError(409, 'อีเมลนี้มีผู้ใช้อยู่แล้ว')
  if (body.branch_id && !(await sql`SELECT 1 FROM platform.branches WHERE id = ${body.branch_id}`).length) throw new HttpError(422, 'ไม่พบสาขา')
  const id = crypto.randomUUID(), pw = tempPassword()
  const queries = [
    sql`INSERT INTO platform.users (id, email, display_name, password_hash, branch_id, status)
        VALUES (${id}, ${email}, ${body.display_name.trim()}, ${await hashPassword(pw)}, ${body.branch_id ?? null}, 'active')`,
    sql`INSERT INTO platform.user_roles (user_id, role_id) SELECT ${id}, x FROM unnest(${[...new Set(body.role_ids)]}::uuid[]) AS x`,
    audit(ctx, { action: 'create_user', table: 'platform.users', id, ref: email, after: { email, display_name: body.display_name.trim(), roles: roles.map((r) => r.code), note },
      risk: roles.some((r) => r.code === 'admin') ? 'high' : 'medium' }),
  ]
  return { id, email, temp_password: pw, queries }
}
