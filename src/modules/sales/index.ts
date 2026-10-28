import { Elysia } from 'elysia'
import { errorHandler } from '../../shared/errors'
import { customerRoutes } from './routes/customers'
import { documentRoutes } from './routes/documents'
import { paymentRoutes } from './routes/payments'
import { crmRoutes } from './routes/crm'

/**
 * โมดูลฝ่ายขาย (prefix /sales) — ใช้ใน src/index.ts:  .use(salesModule)
 * ทุก endpoint ต้องล็อกอิน + มีบทบาท sales + มีสิทธิ์โมดูล sales/crm ตามที่ Admin ตั้ง
 * แตะตารางใน sales.*, master.customers/parties, และอ่าน accounting.invoices (AR, ดูอย่างเดียว)
 * สร้างคำขออนุมัติใน platform.requests/request_steps · ไม่แตะ inventory.* และไม่อ่านต้นทุน (master.item_costs)
 */
export const salesModule = new Elysia({ prefix: '/sales' })
  .onError({ as: 'global' }, errorHandler)
  .use(customerRoutes)
  .use(documentRoutes)
  .use(paymentRoutes)
  .use(crmRoutes)
