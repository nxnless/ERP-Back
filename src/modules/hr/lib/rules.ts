import { t } from 'elysia'
import { HttpError } from '../../../shared/errors'

export const UUID = t.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' })
export const MONTH = t.String({ pattern: '^\\d{4}-(0[1-9]|1[0-2])$' })
export const DATE = t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })

export const beYear = (y = new Date().getFullYear()) => y + 543
/** รหัสรอบเงินเดือน: PR-2569-11 (ปี พ.ศ.-เดือน) */
export const runNo = (month: string) => { const [y, m] = month.split('-'); return `PR-${Number(y) + 543}-${m}` }

/** บทบาทที่ HR ขอเปิดบัญชีให้พนักงานใหม่ไม่ได้ — ผู้ดูแลระบบเท่านั้น (บทบาทอื่นรวมผู้จัดการ/ผู้บริหารขอได้ ผู้ดูแลระบบจะตรวจและแก้บทบาทก่อนสร้างบัญชีที่หน้า "คำขอเปิดบัญชี") */
export const BLOCKED_ROLES = ['admin']

/** รายการปรับปรุงเงินเดือนที่ HR เลือกได้ — component ตรงกับ CHECK ของ hr.payroll_items */
export const ADJUSTMENTS = {
  earning: [{ component: 'BONUS', label: 'โบนัส' }, { component: 'COMMISSION', label: 'คอมมิชชัน' }, { component: 'OTHER_EARN', label: 'เงินอื่น ๆ' }],
  deduction: [{ component: 'ABSENCE', label: 'หักขาดงาน' }, { component: 'STUDENT_LOAN', label: 'หัก กยศ.' }, { component: 'OTHER_DEDUCT', label: 'หักอื่น ๆ' }],
} as const
export const adjustmentKind = (component: string): 'earning' | 'deduction' | null =>
  ADJUSTMENTS.earning.some((a) => a.component === component) ? 'earning' : ADJUSTMENTS.deduction.some((a) => a.component === component) ? 'deduction' : null

/** ประกันสังคม 5% ของเงินเดือน สูงสุด 750 บาท/เดือน (กองทุนสำรองเลี้ยงชีพใช้ % รายคนจาก hr.compensation) */
export const SSO = { rate: 0.05, cap: 750 }

export function assertAdjustment(a: { component: string; reason: string }) {
  if (!adjustmentKind(a.component)) throw new HttpError(422, 'ประเภทรายการไม่ถูกต้อง')
  if (!a.reason.trim()) throw new HttpError(422, 'ต้องระบุเหตุผล')
}
