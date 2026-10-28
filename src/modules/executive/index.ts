import { Elysia } from 'elysia'
import { errorHandler } from '../../shared/errors'
import { approvalRoutes } from '../approvals/routes'
import { executiveOnly } from './guard'
import { overviewRoutes } from './routes/overview'

/**
 * โมดูลผู้บริหาร (prefix /executive) — ใช้ใน src/index.ts:  .use(executiveModule)
 *  - /inbox     กล่องอนุมัติรายการสำคัญ (ขั้นที่ผู้อนุมัติเป็นบทบาท executive) — ตรรกะอยู่ในโมดูลกลาง approvals/
 *  - /overview  ภาพรวมบริษัททุกสาขา (อ่านอย่างเดียว) — แต่ละส่วนแสดงเมื่อบทบาทมีสิทธิ์อ่านโมดูลนั้นเท่านั้น
 * แก้นโยบายอนุมัติไม่ได้ (เป็นของ Admin) · อนุมัติคำขอของตนเองไม่ได้
 */
export const executiveModule = new Elysia({ prefix: '/executive' })
  .onError({ as: 'global' }, errorHandler)
  .use(approvalRoutes(executiveOnly, 'executive'))
  .use(overviewRoutes)
