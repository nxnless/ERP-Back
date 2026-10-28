import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { openapi } from '@elysiajs/openapi'
import { authModule } from './auth'
import { employeeModule } from './modules/employee'
import { adminModule } from './modules/admin'
import { hrModule } from './modules/hr'
import { managerModule } from './modules/manager'
import { accountingModule } from './modules/accounting'
import { purchasingModule } from './modules/purchasing'
import { warehouseModule } from './modules/warehouse'
import { salesModule } from './modules/sales'
import { executiveModule } from './modules/executive'
import { portalModule } from './modules/portal'

export const app = new Elysia()
  .use(
    cors({
      origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id']
    })
  )
  .use(openapi({ path: '/openapi' }))
  .get('/health', () => ({ ok: true, status: 'ok' }))
  .use(authModule)
  .use(employeeModule)
  .use(adminModule)
  .use(hrModule)
  .use(managerModule)
  .use(accountingModule)
  .use(purchasingModule)
  .use(warehouseModule)
  .use(salesModule)
  .use(executiveModule)
  .use(portalModule)

export type App = typeof app
