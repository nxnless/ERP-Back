import { Elysia } from 'elysia'
import { authPlugin } from '../../plugins/auth'
import { ErrorModel } from '../../shared/model'
import { AuthModel } from './model'
import { AuthService } from './service'

export const auth = new Elysia({ prefix: '/auth', name: 'module.auth' })
  .use(authPlugin) // ได้ `jwt` มาใช้เซ็น token
  .post(
    '/sign-up',
    async ({ body, jwt }) => {
      const user = await AuthService.signUp(body)
      return { token: await jwt.sign({ sub: user.id }) }
    },
    {
      body: AuthModel.signUp,
      response: { 200: AuthModel.token, 409: ErrorModel },
      detail: { tags: ['Auth'], summary: 'Create account' }
    }
  )
  .post(
    '/sign-in',
    async ({ body, jwt }) => {
      const user = await AuthService.signIn(body)
      return { token: await jwt.sign({ sub: user.id }) }
    },
    {
      body: AuthModel.signIn,
      response: { 200: AuthModel.token, 401: ErrorModel },
      detail: { tags: ['Auth'], summary: 'Sign in' }
    }
  )
