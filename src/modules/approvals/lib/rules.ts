import { t } from 'elysia'

export const UUID = t.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' })

/**
 * ประเภทคำขอที่กล่องอนุมัติรองรับ — ต้องมีตัวอัปเดตเอกสารต้นทางใน decide.ts (หรือเป็นคำขอที่มีแต่ payload)
 * ประเภทอื่น (EXPENSE, PAYMENT, PAYROLL ฯลฯ) จะยังไม่ขึ้นในกล่องจนกว่าจะเพิ่มตัวอัปเดต
 */
export const TYPE_LABEL: Record<string, string> = {
  PO: 'ใบสั่งซื้อ', QUOTATION: 'ใบเสนอราคา', LEAVE: 'ใบลา', OT: 'ขอทำ OT', PR: 'ใบขอซื้อ', SUPPLIER: 'ขอเพิ่มซัพพลายเออร์', HEADCOUNT: 'ขออัตรากำลัง',
}

/**
 * ประเภทคำขอที่แต่ละบทบาท "เห็นและอนุมัติ" ในกล่องอนุมัติได้ — เพิ่มบทบาทใหม่ (เช่น manager, dept_head) ได้ที่นี่
 * บทบาทที่ไม่อยู่ในรายการนี้ใช้ approvalRoutes() ไม่ได้
 */
export const ROLE_TYPES: Record<string, string[]> = {
  executive: Object.keys(TYPE_LABEL),
  purchasing_head: ['PO', 'SUPPLIER', 'PR'],
  dept_head: ['PR'],
}

/** ชื่อประเภทเอกสารทั้งหมดสำหรับตารางนโยบาย (เหมือน DOC_TYPES ของโมดูล Admin) */
export const DOC_TYPES: Record<string, string> = {
  PO: 'ใบสั่งซื้อ', QUOTATION: 'ใบเสนอราคา', QUOTATION_DISCOUNT: 'ส่วนลดใบเสนอราคา', EXPENSE: 'เบิกค่าใช้จ่าย', LEAVE: 'ใบลา', OT: 'ขอทำ OT',
  PR: 'ใบขอซื้อ', ISSUE: 'ขอเบิกสินค้า', CREDIT_EXCEPTION: 'ขอยกเว้นเครดิตลูกค้า', DATA_CHANGE: 'ขอแก้ข้อมูลพนักงาน', ACCOUNT: 'ขอเปิดบัญชีผู้ใช้',
  HEADCOUNT: 'ขออัตรากำลัง', PAYMENT: 'ขอจ่ายเงินเจ้าหนี้', SUPPLIER: 'ขอเพิ่มซัพพลายเออร์', COUNT_ADJUST: 'ปรับยอดตรวจนับสต็อก',
  PAYROLL: 'รอบเงินเดือน', BANK_CHANGE: 'เปลี่ยนบัญชีธนาคาร',
}

/** รอเกินกี่วันถือว่า "ค้างนาน" (แสดงป้ายเตือนและเรียงขึ้นก่อน) */
export const STALE_DAYS = 3

export const fm = (n: number) => Math.round(n).toLocaleString('th-TH')

/** วันที่แบบไทย พ.ศ. เขตเวลาไทย เช่น 6 ต.ค. 2569 (time=true เติมเวลา) */
export const thDate = (d: string | Date, time = false) => {
  const x = new Date(d)
  const date = x.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' })
  return time ? `${date} ${x.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok' })}` : date
}

/** ข้อความนโยบายที่ทำให้รายการมาถึงผู้บริหาร เช่น "ใบสั่งซื้อ มากกว่า 500,000 บาท ต้องให้ผู้บริหารอนุมัติ" */
export function policyText(type: string, p: { min_amount: number; max_amount: number | null } | undefined, role = 'ผู้บริหาร') {
  const label = DOC_TYPES[type] ?? type
  if (!p || (p.min_amount === 0 && p.max_amount == null)) return `${label} ต้องให้${role}อนุมัติ`
  const range = p.min_amount === 0 ? `ไม่เกิน ${fm(p.max_amount as number)} บาท`
    : p.max_amount == null ? `มากกว่า ${fm(Math.floor(p.min_amount))} บาท`
    : `${fm(Math.ceil(p.min_amount))} – ${fm(p.max_amount)} บาท`
  return `${label} ${range} ต้องให้${role}อนุมัติ`
}
