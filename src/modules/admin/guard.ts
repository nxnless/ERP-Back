import { Elysia } from 'elysia'
import { authenticated } from '../../auth/plugin'
import { HttpError } from '../../shared/errors'

const ipOf = (h: Record<string, string | undefined>) => {
  const v = (h['x-forwarded-for']?.split(',')[0] ?? h['x-real-ip'] ?? '').trim()
  return /^[0-9a-fA-F:.]{3,45}$/.test(v) ? v : null // ใส่ลง audit_log.ip (inet) ได้เฉพาะที่เป็น IP จริง
}

/** ทุก route ของ Admin ต้องผ่านด่านนี้: ล็อกอินแล้ว + มีบทบาท admin (ไม่ใช่ = 403) และได้ `ip` ไว้บันทึก audit */
export const adminOnly = new Elysia({ name: 'admin/guard' })
  .use(authenticated)
  .onBeforeHandle(({ session }) => {
    if (!session.roles.includes('admin')) throw new HttpError(403, 'เฉพาะผู้ดูแลระบบเท่านั้น')
  })
  .derive(({ headers }) => ({ ip: ipOf(headers) }))
  .as('scoped') // ยก session / ip / ด่านตรวจสิทธิ์ ให้ route ที่ .use(adminOnly) ใช้ต่อได้
