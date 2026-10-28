import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { authModule } from './auth'
import { employeeModule } from './modules/employee'
// import { managerModule } from '../manager'   ← ตำแหน่งอื่นต่อที่นี่
import { adminModule } from './modules/admin'
import { hrModule } from './modules/hr'
import {accountingModule} from './modules/accounting'
import {managerModule} from './modules/manager'
import {portalModule} from './modules/portal'
import {purchasingModule} from './modules/purchasing'
import {warehouseModule} from './modules/warehouse'
import {salesModule} from './modules/sales'
import { executiveModule } from './modules/executive'
new Elysia()
  .use(cors({ origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173', allowedHeaders: ['Content-Type', 'Authorization'] }))
  .get('/health', () => ({ ok: true }))
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
  .listen(Number(process.env.PORT ?? 3000))

console.log(`API พร้อมที่พอร์ต ${process.env.PORT ?? 3000}`)
