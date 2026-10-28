import { t } from 'elysia'

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
  token: t.Object({ token: t.String() })
}

export type SignUpBody = typeof AuthModel.signUp.static
export type SignInBody = typeof AuthModel.signIn.static
