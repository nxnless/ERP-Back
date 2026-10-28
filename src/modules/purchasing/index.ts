import { Elysia } from 'elysia'
import { errorHandler } from '../../shared/errors'
import { approvalRoutes } from '../approvals/routes'
import { purchasingApprover } from './guard'
import { supplierRoutes } from './routes/suppliers'
import { orderRoutes } from './routes/orders'
import { rfqRoutes } from './routes/rfq'
import { reorderRoutes } from './routes/reorder'

/**
 * โมดูลฝ่ายจัดซื้อ (prefix /purchasing) — ใช้ใน src/index.ts:  .use(purchasingModule)
 * ทุก endpoint ต้องล็อกอิน เป็นบทบาท purchasing / purchasing_head และมีสิทธิ์โมดูล purchasing
 * ออก PO ได้ แต่อนุมัติของตนเองไม่ได้ — PO/PR/ซัพพลายเออร์ใหม่ ถูกส่งเข้า platform.requests ตามนโยบายใน platform.approval_policies
 * หัวหน้าจัดซื้อ (purchasing_head) และหัวหน้าแผนก (dept_head) อนุมัติขั้นของตนได้ที่ /purchasing/inbox
 */
export const purchasingModule = new Elysia({ prefix: '/purchasing' })
  .onError({ as: 'global' }, errorHandler)
  .use(supplierRoutes)
  .use(orderRoutes)
  .use(rfqRoutes)
  .use(reorderRoutes)
  .use(approvalRoutes(purchasingApprover, ['purchasing_head', 'dept_head'])) // /purchasing/inbox — หัวหน้าจัดซื้อ: PO/ซัพพลายเออร์/PR · หัวหน้าแผนก: PR
