import { Elysia } from 'elysia'
import { authenticated } from '../../auth/plugin'
import { sql } from '../../shared/db'
import { HttpError } from '../../shared/errors'

const ipOf = (h: Record<string, string | undefined>) => {
  const v = (h['x-forwarded-for']?.split(',')[0] ?? h['x-real-ip'] ?? '').trim()
  return /^[0-9a-fA-F:.]{3,45}$/.test(v) ? v : null // ใส่ลง audit_log.ip (inet) ได้เฉพาะที่เป็น IP จริง
}

const RANK = { none: 0, read: 1, write: 2, manage: 3 } as const
export type Level = keyof typeof RANK

/** สิทธิ์สูงสุดของบทบาทที่ผู้ใช้ถืออยู่ ในโมดูล "inventory" (นับเฉพาะเมื่อโมดูลเปิดอยู่) */
async function inventoryLevel(roles: string[]): Promise<Level> {
  const rows = await sql`
    SELECT a.level FROM platform.role_module_access a
      JOIN platform.roles r ON r.id = a.role_id JOIN platform.modules m ON m.code = a.module_code
     WHERE a.module_code = 'inventory' AND m.enabled AND r.code = ANY(${roles}::text[])`
  return rows.reduce((best: Level, r) => (RANK[r.level as Level] > RANK[best] ? (r.level as Level) : best), 'none' as Level)
}

/**
 * ทุก route ของคลังสินค้าต้องผ่านด่านนี้: ล็อกอินแล้ว + มีบทบาท warehouse + โมดูล inventory เปิดอยู่และมีสิทธิ์อย่างน้อย "ดู"
 * ได้ `ip` (ไว้บันทึก audit) และ `access` (none/read/write/manage) ให้ route ใช้ต่อ — route ที่แก้ข้อมูลใส่ `beforeHandle: needWrite`
 */
export const warehouseOnly = new Elysia({ name: 'warehouse/guard' })
  .use(authenticated)
  .derive(async ({ session, headers }) => ({
    ip: ipOf(headers),
    access: session ? await inventoryLevel(session.roles) : ('none' as Level),
  }))
  .onBeforeHandle(({ session, access }) => {
    if (!session.roles.includes('warehouse')) throw new HttpError(403, 'เฉพาะเจ้าหน้าที่คลังสินค้าเท่านั้น')
    if (access === 'none') throw new HttpError(403, 'ไม่มีสิทธิ์ใช้งานโมดูลคลังสินค้า (หรือโมดูลถูกปิดอยู่)')
  })
  .as('scoped')

/** ใช้เป็น `beforeHandle` ของ route ที่เปลี่ยนแปลงข้อมูล — สิทธิ์ "ดู" อย่างเดียวทำไม่ได้ */
export const needWrite = ({ access }: { access: Level }) => {
  if (RANK[access] < RANK.write) throw new HttpError(403, 'สิทธิ์ของคุณดูข้อมูลได้อย่างเดียว ทำรายการไม่ได้')
}
