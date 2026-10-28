import { Elysia } from 'elysia'
import { portalOnly } from '../guard'

export const meRoutes = new Elysia()
  .use(portalOnly)
  .get('/me', ({ me }) => ({
    user: { name: me.name, email: me.email, mfa: me.mfa },
    party: { name: me.partyName, code: me.partyCode },
    kinds: me.kinds,
  }))
