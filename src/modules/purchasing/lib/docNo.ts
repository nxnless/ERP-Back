import { sql } from '../../../shared/db'
import { beYear } from './rules'

/** ตาราง/คอลัมน์ที่ใช้รันเลขเอกสาร (ค่าคงที่ ไม่รับจากผู้ใช้ เพราะต่อเป็น SQL ตรง ๆ) */
const KIND = {
  PO: ['purchasing.purchase_orders', 'doc_no'],
  PR: ['purchasing.purchase_requisitions', 'doc_no'],
  REQ: ['platform.requests', 'request_no'],
  SUP: ['master.parties', 'code'],
} as const

/**
 * เลขถัดไปของปีนี้ เช่น PO-2569-0237 (ตารางไม่มี sequence/trigger — แอปรันเอง)
 * SUP ไม่ใส่ปี: SUP-0009
 */
export async function nextNo(kind: keyof typeof KIND) {
  const [table, col] = KIND[kind]
  const prefix = kind === 'SUP' ? 'SUP-' : `${kind}-${beYear()}-`
  const rows = await sql.query(
    `SELECT COALESCE(max(substring(${col} from '[0-9]+$')::int), 0) + 1 AS n FROM ${table} WHERE ${col} LIKE $1`,
    [prefix + '%'],
  )
  return prefix + String(rows[0].n).padStart(4, '0')
}

/** ชนเลขซ้ำ (UNIQUE) เมื่อสองคนออกเอกสารพร้อมกัน → รันเลขใหม่แล้วลองอีกครั้ง (ทั้งชุดอยู่ใน transaction จึงไม่มีของค้าง) */
export async function retryNo<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn() } catch (e: any) { if (e?.code !== '23505' || i >= tries) throw e }
  }
}
