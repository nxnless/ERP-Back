import { Elysia, t } from 'elysia'
import { sql } from '../shared/db'
import { HttpError, errorHandler } from '../shared/errors'
import { authenticated } from './plugin'
import { burnVerify, verifyPassword } from './password'
import { clearFails, isLimited, recordFail } from './rateLimit'
import { assertAuthConfig, signToken, TOKEN_TTL_SECONDS } from './token'

assertAuthConfig()

const clientIp = (h: Record<string, string | undefined>) => (h['x-forwarded-for']?.split(',')[0] ?? h['x-real-ip'] ?? 'unknown').trim()
const WRONG = 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' // ข้อความเดียวสำหรับทุกกรณีที่ยืนยันตัวตนไม่ผ่าน (ไม่บอกว่าอีเมลมีหรือไม่)

/** ระบบ login — ใช้ร่วมกันทุกตำแหน่ง: app.use(authModule) → POST /auth/login · GET /auth/me · POST /auth/logout */
export const authModule = new Elysia({ prefix: '/auth' })
  .onError({ as: 'global' }, errorHandler)
  .post(
    '/login',
    async ({ body, headers }) => {
      const email = body.email.trim().toLowerCase()
      const byIp = `${clientIp(headers)}|${email}`
      if (isLimited(byIp, 5) || isLimited(email, 10))
        throw new HttpError(429, 'พยายามเข้าสู่ระบบหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วลองใหม่')

      const [u] = await sql`
        SELECT id, email, display_name, password_hash, status, mfa_enabled FROM platform.users WHERE lower(email) = ${email}`
      const ok = u?.password_hash ? await verifyPassword(body.password, u.password_hash) : (await burnVerify(body.password), false)
      if (!ok) {
        recordFail(byIp); recordFail(email)
        throw new HttpError(401, WRONG)
      }
      // ถึงตรงนี้ = รหัสผ่านถูกต้องแล้ว จึงบอกสถานะบัญชีได้
      if (u.status === 'suspended') throw new HttpError(403, 'บัญชีนี้ถูกระงับ กรุณาติดต่อผู้ดูแลระบบ')
      if (u.status !== 'active') throw new HttpError(403, 'บัญชียังไม่เปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ')
      // schema มี mfa_enabled แต่ยังไม่มีที่เก็บ secret ของ TOTP — ปฏิเสธชัดเจนดีกว่าข้ามขั้นตอนไปเงียบ ๆ
      if (u.mfa_enabled) throw new HttpError(501, 'บัญชีนี้เปิดใช้การยืนยันตัวตนแบบ 2 ขั้นตอน ซึ่งระบบยังไม่รองรับ กรุณาติดต่อผู้ดูแลระบบ')

      clearFails(byIp); clearFails(email)
      const roles = (await sql`
        SELECT r.code FROM platform.user_roles ur JOIN platform.roles r ON r.id = ur.role_id WHERE ur.user_id = ${u.id} ORDER BY r.code`).map((r) => r.code as string)
      await sql`UPDATE platform.users SET last_login_at = now() WHERE id = ${u.id}`
      return { token: await signToken(u.id), expires_in: TOKEN_TTL_SECONDS, user: { id: u.id, email: u.email, name: u.display_name, roles } }
    },
    { body: t.Object({ email: t.String({ minLength: 3, maxLength: 254 }), password: t.String({ minLength: 1, maxLength: 200 }) }) },
  )
  .use(authenticated)
  // ใช้ตอนเปิดแอปเพื่อกู้เซสชันจาก token ที่เก็บไว้
  .get('/me', ({ session }) => ({ id: session.userId, email: session.email, name: session.name, roles: session.roles }))
  // token เป็นแบบ stateless: ออกจากระบบ = ฝั่ง client ทิ้ง token (ระงับบัญชีทาง DB มีผลทันทีเพราะตรวจสถานะทุก request)
  .post('/logout', () => ({ ok: true }))
