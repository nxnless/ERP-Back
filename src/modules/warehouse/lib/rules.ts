import { t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'

export const UUID = t.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' })
/** จำนวนสินค้า > 0 (numeric(18,3) ในฐานข้อมูล) */
export const QTY = t.Number({ minimum: 0.001, maximum: 1_000_000_000 })
export const QTY0 = t.Number({ minimum: 0, maximum: 1_000_000_000 })

/** สถานะใบสั่งซื้อที่ "รอรับสินค้า" ได้ */
export const RECEIVABLE = ['approved', 'sent_to_supplier', 'supplier_confirmed', 'shipped', 'partially_received']

export const REASONS = ['miscount', 'damaged', 'misplaced', 'unrecorded', 'unknown'] as const
export const ReasonCode = t.Union(REASONS.map((r) => t.Literal(r)))

export const num = (v: unknown) => Number(v ?? 0)

/** แปลง constraint ของฐานข้อมูล (สต็อกติดลบ / รับเกินสั่ง / เลขเอกสารซ้ำ) เป็นข้อความที่ผู้ใช้เข้าใจ — ครอบด้านนอกสุดของทุกการเขียน */
export async function pg<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e: any) {
    if (e?.code === '23514' || e?.code === '23505')
      throw new HttpError(409, 'ข้อมูลเปลี่ยนแปลงระหว่างบันทึก (สต็อกไม่พอ รับเกินจำนวน หรือทำรายการซ้ำ) — โหลดข้อมูลใหม่แล้วลองอีกครั้ง')
    throw e
  }
}

export async function assertWarehouse(id: string) {
  const [w] = await sql`SELECT id, code, name, branch_id FROM master.warehouses WHERE id = ${id} AND active`
  if (!w) throw new HttpError(422, 'ไม่พบคลังสินค้า')
  return w as { id: string; code: string; name: string; branch_id: string | null }
}

/** ยอดคงเหลือ/ยอดถูกจอง/พร้อมใช้ ของสินค้าในคลังหนึ่ง (ไม่นับการจองของเอกสาร ref ที่กำลังดำเนินการ — เช่นใบสั่งขายที่กำลังจ่ายของ) */
export async function stockAt(warehouseId: string, itemIds: string[], ref?: { table: string | null; id: string | null }) {
  const rows = await sql`
    SELECT i.id, i.sku, i.name, i.uom,
           COALESCE(b.on_hand, 0)::float8 AS on_hand,
           COALESCE((SELECT sum(r.qty) FROM inventory.stock_reservations r
                      WHERE r.item_id = i.id AND r.warehouse_id = ${warehouseId} AND r.released_at IS NULL
                        AND NOT (r.ref_table IS NOT DISTINCT FROM ${ref?.table ?? null}::text AND r.ref_id IS NOT DISTINCT FROM ${ref?.id ?? null}::uuid)), 0)::float8 AS reserved
      FROM master.items i
      LEFT JOIN inventory.stock_balances b ON b.item_id = i.id AND b.warehouse_id = ${warehouseId}
     WHERE i.id = ANY(${itemIds}::uuid[])`
  return new Map(rows.map((r) => [r.id as string, { ...r, available: Number(r.on_hand) - Number(r.reserved) } as { id: string; sku: string; name: string; uom: string; on_hand: number; reserved: number; available: number }]))
}
