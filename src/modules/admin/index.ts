import { Elysia } from 'elysia'
import { errorHandler } from '../../shared/errors'
import { overviewRoutes } from './routes/overview'
import { userRoutes } from './routes/users'
import { roleRoutes } from './routes/roles'
import { workflowRoutes } from './routes/workflow'
import { formRoutes } from './routes/forms'
import { accountRoutes } from './routes/accounts'
import { auditRoutes } from './routes/audit'

/**
 * โมดูลผู้ดูแลระบบ (prefix /admin) — ใช้ใน src/index.ts:  .use(adminModule)
 * ทุก endpoint ต้องล็อกอินและมีบทบาท admin; แตะเฉพาะตารางใน platform.* กับ audit.audit_log
 * (ข้อยกเว้นเดียว: ผูก hr.employees.user_id ตอนดำเนินการคำขอเปิดบัญชี)
 */
export const adminModule = new Elysia({ prefix: '/admin' })
  .onError({ as: 'global' }, errorHandler)
  .use(overviewRoutes)
  .use(userRoutes)
  .use(roleRoutes)
  .use(workflowRoutes)
  .use(formRoutes)
  .use(accountRoutes)
  .use(auditRoutes)
