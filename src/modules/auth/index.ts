import { Elysia } from 'elysia'
import { authPlugin } from '../../plugins/auth'
import { ErrorModel } from '../../shared/model'
import { AuthModel } from './model'
import { AuthService } from './service'

export const auth = new Elysia({ prefix: '/auth', name: 'module.auth' })
  .use(authPlugin) // ได้ `jwt` มาใช้เซ็น token

  // ─── Sign-up (เก็บชื่อ REST เดิมไว้ด้วย) ────────────────────────────────────
  .post(
    '/sign-up',
    async ({ body, jwt }) => {
      const user = await AuthService.signUp(body)
      const token = await jwt.sign({ sub: user.id })
      return { token, user: AuthService.getMe(user.id) }
    },
    {
      body: AuthModel.signUp,
      response: { 200: AuthModel.loginResponse, 409: ErrorModel },
      detail: { tags: ['Auth'], summary: 'Create account' }
    }
  )

  // ─── Sign-in (ชื่อ REST เดิม) ────────────────────────────────────────────────
  .post(
    '/sign-in',
    async ({ body, jwt }) => {
      const user = await AuthService.signIn(body)
      const token = await jwt.sign({ sub: user.id })
      return { token, user: AuthService.getMe(user.id) }
    },
    {
      body: AuthModel.signIn,
      response: { 200: AuthModel.loginResponse, 401: ErrorModel },
      detail: { tags: ['Auth'], summary: 'Sign in' }
    }
  )

  // ─── /login — alias ที่ Frontend เรียก ──────────────────────────────────────
  .post(
    '/login',
    async ({ body, jwt }) => {
      const user = await AuthService.signIn(body)
      const token = await jwt.sign({ sub: user.id })
      return { token, user: AuthService.getMe(user.id) }
    },
    {
      body: AuthModel.signIn,
      response: { 200: AuthModel.loginResponse, 401: ErrorModel },
      detail: { tags: ['Auth'], summary: 'Login (alias of sign-in)' }
    }
  )

  // ─── /me — ดึงข้อมูล user ปัจจุบัน (ต้องมี token) ──────────────────────────
  .get(
    '/me',
    ({ userId }) => AuthService.getMe(userId),
    {
      isAuth: true,
      response: { 200: AuthModel.user, 401: ErrorModel },
      detail: { tags: ['Auth'], summary: 'Get current user' }
    }
  )

  // ─── /logout — Frontend เรียก แต่ JWT stateless จึง clear ที่ client เอง ───
  .post(
    '/logout',
    () => ({ ok: true }),
    {
      isAuth: true,
      detail: { tags: ['Auth'], summary: 'Logout (client should clear token)' }
    }
  )
