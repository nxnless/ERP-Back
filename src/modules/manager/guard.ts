import { Elysia } from 'elysia'
import { authenticated } from '../../auth/plugin'
import { sql } from '../../shared/db'
import { HttpError } from '../../shared/errors'

const ipOf = (h: Record<string, string | undefined>) => {
  const v = (h['x-forwarded-for']?.split(',')[0] ?? h['x-real-ip'] ?? '').trim()
  return /^[0-9a-fA-F:.]{3,45}$/.test(v) ? v : null // ใส่ลง audit_log.ip (inet) ได้เฉพาะที่เป็น IP จริง
}

/**
 * ทุก route ของผู้จัดการต้องผ่านด่านนี้: ล็อกอินแล้ว + มีบทบาท manager (ไม่ใช่ = 403)
 * ได้ `ip` ไว้บันทึก audit และ `branchId` (สาขาของผู้จัดการ — ใช้จำกัดขอบเขตข้อมูลทุก query)
 * หมายเหตุ: .resolve ถูกเรียกตามลำดับเดียวกับ onBeforeHandle จึงรันหลังตรวจบทบาทเสมอ
 */
export const managerOnly = new Elysia({ name: 'manager/guard' })
  .use(authenticated)
  .onBeforeHandle(({ session }) => {
    if (!session.roles.includes('manager')) throw new HttpError(403, 'เฉพาะผู้จัดการเท่านั้น')
  })
  .resolve(async ({ session }) => {
    const [u] = await sql`SELECT branch_id FROM platform.users WHERE id = ${session.userId}`
    if (!u?.branch_id) throw new HttpError(403, 'บัญชีนี้ยังไม่ได้กำหนดสาขา — ติดต่อผู้ดูแลระบบ')
    return { branchId: u.branch_id as string }
  })
  .derive(({ headers }) => ({ ip: ipOf(headers) }))
  .as('scoped') // ยก session / ip / branchId / ด่านตรวจสิทธิ์ ให้ route ที่ .use(managerOnly) ใช้ต่อได้
