import { sql } from '../../../shared/db'
import { beYear } from './rules'

const COL = { 'sales.quotations': 'doc_no', 'sales.sales_orders': 'doc_no', 'sales.delivery_notes': 'doc_no', 'platform.requests': 'request_no' } as const

/**
 * เลขที่ถัดไปรูปแบบ PREFIX-ปีพ.ศ.-0001 (DB ไม่มี sequence — อาศัย UNIQUE กันซ้ำ แล้วให้ withRetry ลองใหม่)
 * 'RQ' = เลขคำขออนุมัติ — ถ้าโปรเจคหลักมีรูปแบบเลขคำขออยู่แล้ว ให้เปลี่ยน prefix ที่ lib/approval.ts
 */
export async function nextNo(table: keyof typeof COL, prefix: string) {
  const col = COL[table], head = `${prefix}-${beYear()}-`
  const [r] = await sql.query(`SELECT COALESCE(max(substring(${col} from '[0-9]+$')::int), 0) + 1 AS n FROM ${table} WHERE ${col} LIKE $1`, [head + '%'])
  return head + String(r.n).padStart(4, '0')
}

export async function nextPartyCode() {
  const [r] = await sql`SELECT COALESCE(max(substring(code from '[0-9]+$')::int), 0) + 1 AS n FROM master.parties WHERE code ~ '^C-[0-9]+$'`
  return 'C-' + String(r.n).padStart(5, '0')
}

/** รันซ้ำเมื่อชนเลขที่ซ้ำ (unique_violation 23505) สูงสุด 4 ครั้ง — ให้ fn คำนวณเลขที่ใหม่ทุกรอบ */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn() } catch (e: any) { if (e?.code !== '23505' || i >= 3) throw e }
  }
}
