import { Elysia } from 'elysia'
import { authenticated } from '../../auth/plugin'
import type { Session } from '../../auth/session'
import { sql } from '../../shared/db'
import { HttpError } from '../../shared/errors'

const ipOf = (h: Record<string, string | undefined>) => {
  const v = (h['x-forwarded-for']?.split(',')[0] ?? h['x-real-ip'] ?? '').trim()
  return /^[0-9a-fA-F:.]{3,45}$/.test(v) ? v : null
}

/** บทบาทที่เข้าโมดูลบัญชีได้ (ตรงกับ roles ใน admin/seed.sql) */
export const ACCOUNTING_ROLES = ['accounting', 'accounting_manager']

/** ทุก route ของบัญชีต้องผ่านด่านนี้: ล็อกอินแล้ว + มีบทบาทบัญชี (ไม่ใช่ = 403) และได้ `ip` ไว้บันทึก audit */
export const accountingOnly = new Elysia({ name: 'accounting/guard' })
  .use(authenticated)
  .onBeforeHandle(({ session }) => {
    if (!session.roles.some((r) => ACCOUNTING_ROLES.includes(r))) throw new HttpError(403, 'เฉพาะฝ่ายบัญชีและการเงินเท่านั้น')
  })
  .derive(({ headers }) => ({ ip: ipOf(headers) }))
  .as('scoped')

const RANK = { none: 0, read: 1, write: 2, manage: 3 } as const
type Level = keyof typeof RANK

/** สิทธิ์ตามที่ Admin ตั้งไว้: โมดูลต้องเปิดอยู่ และบทบาทของผู้ใช้ได้ระดับไม่ต่ำกว่า `min` — ใช้เป็น beforeHandle ของ route */
export const moduleAccess = (module: 'accounting' | 'payroll', min: Level) => async ({ session }: { session: Session }) => {
  const [r] = await sql`
    SELECT m.enabled,
           COALESCE(max(CASE a.level WHEN 'manage' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END), 0)::int AS rank
      FROM platform.modules m
      LEFT JOIN platform.role_module_access a ON a.module_code = m.code
           AND a.role_id IN (SELECT id FROM platform.roles WHERE code = ANY(${session.roles}::text[]))
     WHERE m.code = ${module} GROUP BY m.enabled`
  if (!r?.enabled) throw new HttpError(403, 'โมดูลนี้ถูกปิดใช้งาน')
  if (r.rank < RANK[min]) throw new HttpError(403, 'ไม่มีสิทธิ์ทำรายการนี้')
}
