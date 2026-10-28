import { t } from 'elysia'

export const UUID = t.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' })

export const CARD_FEE_PCT = 2.5          // ค่าธรรมเนียมบัตรเครดิต (%) — ลูกค้าเป็นผู้ออก
export const PAYMENT_HOLD_HOURS = 24     // รายการชำระที่ค้างสถานะ initiated เกินนี้ถือว่าหมดอายุ (ชำระซ้ำใบเดิมได้)
export const METHODS = ['promptpay', 'card', 'transfer'] as const

export const feeFor = (method: string, amount: number) => (method === 'card' ? Math.round(amount * CARD_FEE_PCT) / 100 : 0)
