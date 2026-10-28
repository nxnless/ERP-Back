import { t } from 'elysia'

export const UUID = t.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' })

/** วงเงินอนุมัติต่อรายการของผู้จัดการ (บาท) — ปรับได้ด้วย env MANAGER_APPROVAL_LIMIT */
export const APPROVAL_LIMIT = Number(process.env.MANAGER_APPROVAL_LIMIT) > 0 ? Number(process.env.MANAGER_APPROVAL_LIMIT) : 500_000

/** ชนิดคำขอที่ไม่นับวงเงินต่อรายการ (รอบเงินเดือนไม่ใช่ธุรกรรมซื้อ/ขายรายการเดียว — คุมด้วยขั้นตอนตรวจของ HR/บัญชีแทน) */
const LIMIT_EXEMPT = new Set(['PAYROLL'])
export const overLimit = (type: string, amount: number | null) => !LIMIT_EXEMPT.has(type) && (amount ?? 0) > APPROVAL_LIMIT

/** ตรงกับ CHECK ของ platform.requests.type */
export const TYPE_LABEL: Record<string, string> = {
  PO: 'ใบสั่งซื้อ', QUOTATION: 'ใบเสนอราคา', QUOTATION_DISCOUNT: 'ส่วนลดใบเสนอราคา', EXPENSE: 'เบิกค่าใช้จ่าย', LEAVE: 'ใบลา', OT: 'ขอทำ OT',
  PR: 'ใบขอซื้อ', ISSUE: 'ขอเบิกสินค้า', CREDIT_EXCEPTION: 'ขอยกเว้นเครดิตลูกค้า', DATA_CHANGE: 'ขอแก้ข้อมูลพนักงาน', ACCOUNT: 'ขอเปิดบัญชีผู้ใช้',
  HEADCOUNT: 'ขออัตรากำลัง', PAYMENT: 'ขอจ่ายเงินเจ้าหนี้', SUPPLIER: 'ขอเพิ่มซัพพลายเออร์', COUNT_ADJUST: 'ปรับยอดตรวจนับสต็อก',
  PAYROLL: 'รอบเงินเดือน', BANK_CHANGE: 'เปลี่ยนบัญชีธนาคาร',
}

/** module ที่เขียนลง audit.audit_log — ไม่ใช่ platform/auth จึงถูกซ่อนค่าก่อน–หลังจาก Admin (Admin ไม่เห็นข้อมูลธุรกิจ) */
export const MODULE_OF: Record<string, string> = {
  LEAVE: 'hr', OT: 'hr', DATA_CHANGE: 'hr', HEADCOUNT: 'hr', PR: 'purchasing', PO: 'purchasing', SUPPLIER: 'purchasing',
  QUOTATION: 'sales', QUOTATION_DISCOUNT: 'sales', CREDIT_EXCEPTION: 'sales', ISSUE: 'inventory', COUNT_ADJUST: 'inventory',
  EXPENSE: 'accounting', PAYMENT: 'accounting', BANK_CHANGE: 'accounting', PAYROLL: 'payroll',
}
