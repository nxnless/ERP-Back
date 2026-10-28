import { Elysia } from 'elysia'
import { errorHandler } from '../../shared/errors'
import { meRoutes } from './routes/me'
import { invoiceRoutes } from './routes/invoices'
import { quotationRoutes } from './routes/quotations'
import { purchaseOrderRoutes } from './routes/purchase-orders'
import { supplierInvoiceRoutes } from './routes/supplier-invoices'

/**
 * โมดูลพอร์ทัลลูกค้า/ซัพพลายเออร์ (prefix /portal) — ใช้ใน src/index.ts:  .use(portalModule)
 * ทุก endpoint ต้องเป็นผู้ใช้พอร์ทัลที่ active และเห็น/แก้ได้เฉพาะข้อมูลของบริษัทตนเอง (กรองด้วย party_id จากฐานข้อมูล ไม่รับจากหน้าบ้าน)
 * ไม่แตะ platform.* นอกจาก audit · ไม่อ่านต้นทุน (master.item_costs) และไม่มีข้อมูลอนุมัติภายใน
 */
export const portalModule = new Elysia({ prefix: '/portal' })
  .onError({ as: 'global' }, errorHandler)
  .use(meRoutes)
  .use(invoiceRoutes)
  .use(quotationRoutes)
  .use(purchaseOrderRoutes)
  .use(supplierInvoiceRoutes)
