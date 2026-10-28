import { Elysia } from 'elysia'
import { errorHandler } from '../../shared/errors'
import { meRoutes } from './routes/me'
import { timeRoutes } from './routes/time'
import { requestRoutes } from './routes/requests'
import { payslipRoutes } from './routes/payslip'
import { profileRoutes } from './routes/profile'

/**
 * โมดูล "พนักงานทั่วไป" — เอาไป .use(employeeModule) ใน app หลัก
 *   const app = new Elysia().use(employeeModule).listen(3000)
 * ทุก endpoint อยู่ใต้ /employee/* และเห็นเฉพาะข้อมูลของผู้ใช้ที่ล็อกอิน
 */
export const employeeModule = new Elysia({ prefix: '/employee' })
  .onError({ as: 'global' }, errorHandler)
  .use(meRoutes)
  .use(timeRoutes)
  .use(requestRoutes)
  .use(payslipRoutes)
  .use(profileRoutes)
