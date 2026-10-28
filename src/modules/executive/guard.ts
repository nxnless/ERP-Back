import { Elysia } from 'elysia'
import { authenticated } from '../../auth/plugin'
import { sql } from '../../shared/db'
import { HttpError } from '../../shared/errors'

const ipOf = (h: Record<string, string | undefined>) => {
  const v = (h['x-forwarded-for']?.split(',')[0] ?? h['x-real-ip'] ?? '').trim()
  return /^[0-9a-fA-F:.]{3,45}$/.test(v) ? v : null // ใส่ลง audit_log.ip (inet) ได้เฉพาะที่เป็น IP จริง
}

/**
 * ระดับสิทธิ์สูงสุดของบทบาทที่ผู้ใช้ถือในโมดูลหนึ่ง ตามที่ Admin ตั้งไว้ใน role_module_access
 * 0 = none (หรือโมดูลถูกปิด) · 1 = read · 2 = write · 3 = manage
 */
export async function moduleLevel(roles: string[], module: string): Promise<number> {
  const [r] = await sql`
    SELECT m.enabled,
           COALESCE(max(CASE a.level WHEN 'manage' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END), 0)::int AS lvl
      FROM platform.modules m
      LEFT JOIN platform.role_module_access a ON a.module_code = m.code
           AND a.role_id IN (SELECT id FROM platform.roles WHERE code = ANY(${roles}::text[]))
     WHERE m.code = ${module} GROUP BY m.code, m.enabled`
  return r?.enabled ? (r.lvl as number) : 0
}

/** ทุก route ของผู้บริหารต้องผ่านด่านนี้: ล็อกอินแล้ว + มีบทบาท executive (ไม่ใช่ = 403) และได้ `ip` ไว้บันทึก audit */
export const executiveOnly = new Elysia({ name: 'executive/guard' })
  .use(authenticated)
  .onBeforeHandle(({ session }) => {
    if (!session.roles.includes('executive')) throw new HttpError(403, 'เฉพาะผู้บริหารเท่านั้น')
  })
  .derive(({ headers }) => ({ ip: ipOf(headers) }))
  .as('scoped') // ยก session / ip / ด่านตรวจสิทธิ์ ให้ route ที่ .use(executiveOnly) ใช้ต่อได้
