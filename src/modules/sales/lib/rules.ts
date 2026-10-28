import { t } from 'elysia'

export const UUID = t.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' })

// ---------- กติกาธุรกิจของฝ่ายขาย (ปรับตัวเลขที่นี่ที่เดียว) ----------
export const VAT_RATE = 0.07
export const DISCOUNT_FREE_PCT = 5          // ส่วนลดเกินนี้ต้องให้ผู้จัดการอนุมัติ (QUOTATION_DISCOUNT)
export const MAX_DISCOUNT_PCT = 30          // ส่วนลดสูงสุดที่กรอกได้ต่อรายการ
export const EXEC_QUOTE_THRESHOLD = 100_000 // ใบเสนอราคามูลค่า (ก่อน VAT) เกินนี้ต้องผู้บริหารอนุมัติ (QUOTATION)
export const HOLD_OVERDUE_DAYS = 45         // ค้างชำระเกินกี่วัน = ระงับสั่งขายใหม่
export const NEAR_LIMIT_PCT = 90            // ใช้วงเงินเครดิตเกินกี่ % = เตือน "ใกล้เต็ม"
export const QUOTE_VALID_DAYS = 30          // อายุใบเสนอราคา
export const EXCEPTION_VALID_DAYS = 7       // คำขอยกเว้นเครดิตที่อนุมัติแล้ว ใช้ได้กี่วัน
export const NEW_CUSTOMER_CREDIT = 500_000  // วงเงินเริ่มต้นของลูกค้าใหม่ที่ฝ่ายขายเพิ่มเอง
export const MAX_LINES = 50

export const RULES = {
  vat_rate: VAT_RATE, discount_free_pct: DISCOUNT_FREE_PCT, max_discount_pct: MAX_DISCOUNT_PCT, exec_quote_threshold: EXEC_QUOTE_THRESHOLD,
  hold_overdue_days: HOLD_OVERDUE_DAYS, near_limit_pct: NEAR_LIMIT_PCT, new_customer_credit: NEW_CUSTOMER_CREDIT,
}

/** ยอดรวมรายการ (ตรงกับ generated column line_total: qty × ราคา × (1 − ส่วนลด%) ปัดสตางค์) */
export const lineTotal = (qty: number, price: number, disc: number) => Math.round(qty * price * (100 - disc)) / 100

/** ปี พ.ศ. ตามเวลาไทย ใช้ในเลขที่เอกสาร เช่น QT-2569-0161 */
export const beYear = () => new Date(Date.now() + 7 * 3600_000).getUTCFullYear() + 543
