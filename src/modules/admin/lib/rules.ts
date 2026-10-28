import { t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'

export const UUID = t.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' })
export const LEVELS = ['none', 'read', 'write', 'manage'] as const

/** ประเภทคำขอ/เอกสารที่ตั้งนโยบายอนุมัติได้ (ตรงกับ CHECK ของ platform.requests.type) */
export const DOC_TYPES: Record<string, string> = {
  PO: 'ใบสั่งซื้อ', QUOTATION: 'ใบเสนอราคา', QUOTATION_DISCOUNT: 'ส่วนลดใบเสนอราคา', EXPENSE: 'เบิกค่าใช้จ่าย', LEAVE: 'ใบลา', OT: 'ขอทำ OT',
  PR: 'ใบขอซื้อ', ISSUE: 'ขอเบิกสินค้า', CREDIT_EXCEPTION: 'ขอยกเว้นเครดิตลูกค้า', DATA_CHANGE: 'ขอแก้ข้อมูลพนักงาน', ACCOUNT: 'ขอเปิดบัญชีผู้ใช้',
  HEADCOUNT: 'ขออัตรากำลัง', PAYMENT: 'ขอจ่ายเงินเจ้าหนี้', SUPPLIER: 'ขอเพิ่มซัพพลายเออร์', COUNT_ADJUST: 'ปรับยอดตรวจนับสต็อก',
  PAYROLL: 'รอบเงินเดือน', BANK_CHANGE: 'เปลี่ยนบัญชีธนาคาร',
}

/** รหัสผ่านชั่วคราว: สุ่ม 14 ตัว (แสดงให้ Admin เห็นครั้งเดียว ไม่เก็บ) */
export const tempPassword = () => Buffer.from(crypto.getRandomValues(new Uint8Array(11))).toString('base64url').slice(0, 14)

/** ต้องมี Admin ที่ใช้งานอยู่อย่างน้อย 2 คน "หลังจาก" ตัดผู้ใช้ excludeUserId ออก */
export async function assertAdminsRemain(excludeUserId: string) {
  const [r] = await sql`
    SELECT count(DISTINCT u.id)::int AS n FROM platform.users u
      JOIN platform.user_roles ur ON ur.user_id = u.id JOIN platform.roles ro ON ro.id = ur.role_id
     WHERE ro.code = 'admin' AND u.status = 'active' AND u.id <> ${excludeUserId}`
  if (r.n < 2) throw new HttpError(409, 'ต้องมี Admin ที่ใช้งานอยู่อย่างน้อย 2 คน — เพิ่ม Admin คนอื่นก่อนทำรายการนี้')
}

/** แยกหน้าที่: Admin ถือบทบาทอื่นได้เฉพาะ "พนักงาน" (ไม่งั้นจะเปิดทางให้เห็นข้อมูลธุรกิจ/อนุมัติธุรกรรมได้) */
export function assertRoleCombo(codes: string[]) {
  if (!codes.length) throw new HttpError(422, 'ต้องกำหนดอย่างน้อย 1 บทบาท')
  if (codes.includes('admin') && codes.some((c) => c !== 'admin' && c !== 'employee'))
    throw new HttpError(422, 'ผู้ดูแลระบบถือบทบาทอื่นนอกจาก "พนักงาน" ไม่ได้ (แยกหน้าที่ — Admin ต้องไม่เห็นข้อมูลธุรกิจ)')
}

export async function rolesByIds(ids: string[]) {
  const uniq = [...new Set(ids)]
  const rows = await sql`SELECT id, code, name FROM platform.roles WHERE id = ANY(${uniq}::uuid[])`
  if (rows.length !== uniq.length) throw new HttpError(422, 'มีบทบาทที่ไม่พบในระบบ')
  return rows as { id: string; code: string; name: string }[]
}
