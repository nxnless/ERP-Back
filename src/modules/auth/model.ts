import { t } from 'elysia'

// schema ของ user ที่ส่งกลับให้ frontend (ไม่มี passwordHash)
const publicUser = t.Object({
  id: t.String(),
  email: t.String(),
  name: t.String(),
  roles: t.Array(t.String()),
  createdAt: t.String()
})

export const AuthModel = {
  signUp: t.Object({
    email: t.String({ format: 'email' }),
    name: t.String({ minLength: 1 }),
    password: t.String({ minLength: 8 })
  }),
  signIn: t.Object({
    email: t.String({ format: 'email' }),
    password: t.String()
  }),
  // login ส่งคืน { token, user } ให้ frontend 
  loginResponse: t.Object({ token: t.String(), user: publicUser }),
  token: t.Object({ token: t.String() }),
  user: publicUser
}

export type SignUpBody = typeof AuthModel.signUp.static
export type SignInBody = typeof AuthModel.signIn.static
export type PublicAuthUser = typeof publicUser.static
