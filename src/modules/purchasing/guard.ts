import { Elysia } from 'elysia'
import { authenticated } from '../../auth/plugin'
import { sql } from '../../shared/db'
import { HttpError } from '../../shared/errors'

/** บทบาทที่เข้าโมดูลจัดซื้อได้ (ตรงกับ handle.roles ฝั่ง frontend) */
const ROLES = ['purchasing', 'purchasing_head']

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

/**
 * ทุก route ของจัดซื้อต้องผ่านด่านนี้: ล็อกอินแล้ว + เป็นฝ่ายจัดซื้อ + โมดูล purchasing เปิดอยู่
 * GET ต้องมีสิทธิ์ read ขึ้นไป, ที่เหลือ (POST/PUT/DELETE) ต้อง write ขึ้นไป — ตามหน้า "บทบาทและสิทธิ์" ของ Admin
 */
export const purchasingOnly = new Elysia({ name: 'purchasing/guard' })
  .use(authenticated)
  .onBeforeHandle(async ({ session, request }) => {
    if (!session.roles.some((r: string) => ROLES.includes(r))) throw new HttpError(403, 'เฉพาะฝ่ายจัดซื้อเท่านั้น')
    const need = request.method === 'GET' ? 1 : 2
    const have = await moduleLevel(session.roles, 'purchasing')
    if (have < need) throw new HttpError(403, have === 0 ? 'ไม่มีสิทธิ์ใช้โมดูลจัดซื้อ (หรือโมดูลถูกปิดอยู่)' : 'สิทธิ์โมดูลจัดซื้อของคุณดูได้อย่างเดียว')
  })
  .derive(({ headers }) => ({ ip: ipOf(headers) }))
  .as('scoped') // ยก session / ip / ด่านตรวจสิทธิ์ ให้ route ที่ .use(purchasingOnly) ใช้ต่อได้

/**
 * ผู้อนุมัติที่ใช้กล่องอนุมัติในโมดูลจัดซื้อ (ผ่านด่าน purchasingOnly มาแล้ว):
 * หัวหน้าฝ่ายจัดซื้อ (PO / ซัพพลายเออร์ใหม่) และหัวหน้าแผนก (ใบขอซื้อ) — ประเภทที่เห็นกำหนดใน approvals/lib/rules.ts (ROLE_TYPES)
 */
export const purchasingApprover = new Elysia({ name: 'purchasing/approver-guard' })
  .use(purchasingOnly)
  .onBeforeHandle(({ session }) => {
    if (!session.roles.some((r: string) => ['purchasing_head', 'dept_head'].includes(r))) throw new HttpError(403, 'เฉพาะหัวหน้าฝ่ายจัดซื้อหรือหัวหน้าแผนกเท่านั้น')
  })
  .as('scoped')
