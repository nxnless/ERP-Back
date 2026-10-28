import { Elysia } from 'elysia'
import { errorHandler } from '../../shared/errors'
import { employeeRoutes } from './routes/employees'
import { leaveRoutes } from './routes/leave'
import { payrollRoutes } from './routes/payroll'
import { headcountRoutes } from './routes/headcount'

/**
 * โมดูลฝ่ายบุคคล (prefix /hr) — ใช้ใน src/index.ts:  .use(hrModule)
 * ทุก endpoint ต้องล็อกอินและมีบทบาท hr และผ่านสิทธิ์โมดูล hr/payroll ที่ Admin ตั้งไว้
 * HR "เตรียม" เงินเดือนและ "ตรวจ" ใบลาที่เกินสิทธิ์เท่านั้น — ไม่มี endpoint อนุมัติจ่ายเงินเดือน
 */
export const hrModule = new Elysia({ prefix: '/hr' })
  .onError({ as: 'global' }, errorHandler)
  .use(employeeRoutes)
  .use(leaveRoutes)
  .use(payrollRoutes)
  .use(headcountRoutes)
