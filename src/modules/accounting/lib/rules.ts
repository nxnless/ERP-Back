import { t } from 'elysia'

export const UUID = t.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' })
export const MONTH = t.String({ pattern: '^\\d{4}-(0[1-9]|1[0-2])$' })
export const DATE = t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })

/** บัญชีคุมยอดที่ใช้เทียบกับ sub-ledger (ผังบัญชีเริ่มต้นใน seed.sql) */
export const AR_CONTROL = '1120'
export const AP_CONTROL = '2110'
export const ACCRUED_PAYROLL = '2310'

export const beYear = (y = new Date().getFullYear()) => y + 543
export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
export const today = () => new Date().toISOString().slice(0, 10)

/** วันสุดท้ายของเดือน 'YYYY-MM' เป็น 'YYYY-MM-DD' */
export const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}
export const prevMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7) }

/** เลขประจำตัวผู้เสียภาษี 13 หลัก + ตรวจ check digit (ใช้ตอนแก้ข้อมูลผู้ซื้อก่อนส่ง e-Tax ซ้ำ) */
export function validTaxId(id: string) {
  if (!/^\d{13}$/.test(id)) return false
  const d = [...id].map(Number)
  const sum = d.slice(0, 12).reduce((s, x, i) => s + x * (13 - i), 0)
  return (11 - (sum % 11)) % 10 === d[12]
}
