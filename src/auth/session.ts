import { sql } from '../shared/db'
import { HttpError } from '../shared/errors'
import { verifyToken } from './token'

export type Session = { userId: string; name: string; email: string; roles: string[] }

/**
 * อ่าน Authorization: Bearer <jwt> → คืน Session ของผู้ใช้
 * ตรวจสถานะและบทบาทจาก DB สดทุก request: ระงับบัญชี/ถอนบทบาทมีผลทันที ไม่ต้องรอ token หมดอายุ
 */
export async function sessionFromHeaders(headers: Record<string, string | undefined>): Promise<Session> {
  let userId: string | undefined
  const m = /^Bearer\s+(.+)$/i.exec(headers['authorization'] ?? '')
  if (m) {
    try { userId = await verifyToken(m[1]) } catch { throw new HttpError(401, 'เซสชันหมดอายุหรือไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่') }
  } else if (process.env.ALLOW_DEV_AUTH === '1' && process.env.NODE_ENV !== 'production' && headers['x-user-id']) {
    userId = headers['x-user-id'] // โหมดพัฒนาเท่านั้น (ถูกปิดอัตโนมัติเมื่อ NODE_ENV=production)
  }
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) throw new HttpError(401, 'ยังไม่ได้เข้าสู่ระบบ')

  const [u] = await sql`
    SELECT u.id, u.email, u.display_name, u.status,
           COALESCE(array_agg(r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles
      FROM platform.users u
      LEFT JOIN platform.user_roles ur ON ur.user_id = u.id
      LEFT JOIN platform.roles r ON r.id = ur.role_id
     WHERE u.id = ${userId} GROUP BY u.id`
  if (!u || u.status !== 'active') throw new HttpError(401, 'บัญชีนี้ใช้งานไม่ได้ กรุณาติดต่อผู้ดูแลระบบ')
  return { userId: u.id, name: u.display_name, email: u.email, roles: u.roles }
}
