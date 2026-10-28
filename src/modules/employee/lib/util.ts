import { sql } from '../deps'

/** วันนี้ตามเวลาไทย รูปแบบ YYYY-MM-DD */
export const bangkokToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date())
export const bangkokYear = () => Number(bangkokToday().slice(0, 4))
export const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000)

/** เลขที่เอกสาร PREFIX-พ.ศ.-0001 (หาเลขถัดไปจากตารางจริง ชนกันจะ retry — ถ้ามีตาราง counter ให้เปลี่ยนมาใช้แทน) */
export async function nextDocNo(prefix: string, table: string, col: string) {
  const stem = `${prefix}-${bangkokYear() + 543}-`
  const rows = await sql.query(
    `SELECT COALESCE(max(substring(${col} from '[0-9]+$')::int), 0) + 1 AS n FROM ${table} WHERE ${col} LIKE $1`,
    [stem + '%'],
  )
  return stem + String(rows[0].n).padStart(4, '0')
}

/** ทำซ้ำเมื่อเลขที่เอกสารชน (unique violation) */
export async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e: any) {
      if (e?.code === '23505' && i < tries) continue
      throw e
    }
  }
}
