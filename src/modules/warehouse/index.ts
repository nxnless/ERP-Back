import { Elysia } from 'elysia'
import { errorHandler } from '../../shared/errors'
import { stockRoutes } from './routes/stock'
import { receivingRoutes } from './routes/receiving'
import { issueRoutes } from './routes/issues'
import { transferRoutes } from './routes/transfers'
import { countRoutes } from './routes/counts'
import { scanRoutes } from './routes/scan'

/**
 * โมดูลคลังสินค้า (prefix /warehouse) — ใช้ใน src/index.ts:  .use(warehouseModule)
 * ทุก endpoint ต้องล็อกอิน + มีบทบาท warehouse + มีสิทธิ์โมดูล inventory
 * ไม่ส่งราคา/ต้นทุนออกไปที่ client เลย (ไม่ SELECT master.item_costs / unit_price_snap / total ใน route ใด ๆ)
 * แตะเฉพาะ inventory.* และอ่าน master.* / purchasing.po_* ; สร้าง platform.requests ได้ชนิดเดียวคือ COUNT_ADJUST (ส่งผลนับ)
 */
export const warehouseModule = new Elysia({ prefix: '/warehouse' })
  .onError({ as: 'global' }, errorHandler)
  .use(stockRoutes)
  .use(receivingRoutes)
  .use(issueRoutes)
  .use(transferRoutes)
  .use(countRoutes)
  .use(scanRoutes)
