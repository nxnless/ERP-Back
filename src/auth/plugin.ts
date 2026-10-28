import { Elysia } from 'elysia'
import { HttpError } from '../shared/errors'
import { sessionFromHeaders, type Session } from './session'

/** plugin: ใส่ `session` ({ userId, name, email, roles }) ให้ทุก route ที่ .use() ต่อจากนี้ — ไม่ล็อกอิน = 401 */
export const authenticated = new Elysia({ name: 'auth/session' }).derive({ as: 'scoped' }, async ({ headers }) => ({
  session: await sessionFromHeaders(headers),
}))

/**
 * จำกัดตามบทบาท:  app.use(authenticated).guard(requireRole('manager', 'executive'), (g) => g.get('/inbox', ...))
 * ไม่มีบทบาทที่กำหนด = 403
 */
export const requireRole = (...roles: string[]) => ({
  beforeHandle: ({ session }: { session: Session }) => {
    if (!roles.some((r) => session.roles.includes(r))) throw new HttpError(403, 'คุณไม่มีสิทธิ์ใช้งานส่วนนี้')
  },
})
