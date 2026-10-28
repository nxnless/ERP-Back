import { Elysia } from 'elysia'
import { errorHandler } from '../../shared/errors'
import { journalRoutes } from './routes/journal'
import { agingRoutes } from './routes/aging'
import { payrollReviewRoutes } from './routes/payroll-review'
import { taxRoutes } from './routes/tax'
import { bankRoutes } from './routes/bank'
import { statementRoutes } from './routes/statements'

/**
 * โมดูลบัญชีและการเงิน (prefix /accounting) — ใช้ใน src/index.ts:  .use(accountingModule)
 * บัญชีเป็นผู้ "ตรวจ" รอบเงินเดือน (ขั้นอนุมัติของบทบาทบัญชี) — อนุมัติขั้นสุดท้ายและการจ่ายเป็นของผู้จัดการ
 */
export const accountingModule = new Elysia({ prefix: '/accounting' })
  .onError({ as: 'global' }, errorHandler)
  .use(journalRoutes)
  .use(agingRoutes)
  .use(payrollReviewRoutes)
  .use(taxRoutes)
  .use(bankRoutes)
  .use(statementRoutes)
