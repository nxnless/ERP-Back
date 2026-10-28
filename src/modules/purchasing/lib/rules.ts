import { t } from 'elysia'

export const UUID = t.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' })

export const VAT_RATE = 0.07
/** lead time เริ่มต้นของซัพพลายเออร์ใหม่ที่ยังไม่มีประวัติ (วัน) */
export const DEFAULT_LEAD_DAYS = 14
/** สถานะซัพพลายเออร์ที่ออก PO ได้ (ทดลอง = ยังไม่มีประวัติ แต่ซื้อได้) */
export const USABLE_SUPPLIER = ['approved', 'trial']
/** PO ที่ถือว่า "กำลังมา" ตอนคำนวณจุดสั่งซื้อซ้ำ (ไม่นับที่ยังรออนุมัติ เพราะอาจถูกปฏิเสธ) */
export const INCOMING_PO = ['approved', 'sent_to_supplier', 'supplier_confirmed', 'shipped', 'partially_received']

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** ปี พ.ศ. ตามเขตเวลาไทย (ใช้ในเลขที่เอกสาร เช่น PO-2569-0001) */
export const beYear = (d = new Date()) =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', year: 'numeric' }).format(d)) + 543
