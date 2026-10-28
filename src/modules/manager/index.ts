import { Elysia } from 'elysia'
import { errorHandler } from '../../shared/errors'
import { meRoutes } from './routes/me'
import { inboxRoutes } from './routes/inbox'
import { dashboardRoutes } from './routes/dashboard'
import { reportRoutes } from './routes/reports'

/**
 * โมดูลผู้จัดการสาขา (prefix /manager) — ใช้ใน src/index.ts:  .use(managerModule)
 * ทุก endpoint ต้องล็อกอิน มีบทบาท manager และมีสาขา; ข้อมูลทุกชุดถูกจำกัดที่สาขาของผู้จัดการ
 * เขียนได้เฉพาะ platform.request_steps / platform.requests / audit.audit_log
 * และสถานะของเอกสารต้นทางตอนคำขอปิดจบ (ดู lib/finalize.ts)
 */
export const managerModule = new Elysia({ prefix: '/manager' })
  .onError({ as: 'global' }, errorHandler)
  .use(meRoutes)
  .use(inboxRoutes)
  .use(dashboardRoutes)
  .use(reportRoutes)
