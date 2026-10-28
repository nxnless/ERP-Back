import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { needWrite, warehouseOnly } from '../guard'
import { loadStock } from '../lib/stock'
import { UUID } from '../lib/rules'

/**
 * สแกนบาร์โค้ด (หรือพิมพ์ SKU): โหมด lookup = ดูสต็อกของสินค้า · โหมด count = บวกยอดนับ +1 ในรอบตรวจนับที่เปิดอยู่
 * ทุกครั้งบันทึกลง inventory.scan_events (รวมครั้งที่ไม่พบสินค้า)
 */
export const scanRoutes = new Elysia()
  .use(warehouseOnly)
  .post('/scan', async ({ body, session, access }) => {
    if (body.mode === 'count') needWrite({ access }) // นับ = เขียนยอดนับ ต้องมีสิทธิ์แก้ไข · ค้นหาอย่างเดียวใช้สิทธิ์ดูได้
    const code = body.barcode.trim()
    const [item] = await sql`SELECT id FROM master.items WHERE active AND (barcode = ${code} OR lower(sku) = lower(${code})) LIMIT 1`
    if (!item) {
      await sql`INSERT INTO inventory.scan_events (user_id, barcode, item_id, mode) VALUES (${session.userId}, ${code}, NULL, ${body.mode})`
      throw new HttpError(404, `ไม่พบบาร์โค้ด/รหัส ${code} ในระบบ`)
    }
    let counted: number | null = null
    if (body.mode === 'count') {
      if (!body.count_id) throw new HttpError(422, 'โหมดนับต้องระบุรอบตรวจนับ')
      const [c] = await sql`SELECT status FROM inventory.stock_counts WHERE id = ${body.count_id}`
      if (!c || c.status !== 'open') throw new HttpError(409, 'รอบตรวจนับนี้ปิดแล้ว — เริ่มรอบใหม่ก่อนสแกนนับ')
      const [, upd] = await sql.transaction([
        sql`INSERT INTO inventory.scan_events (user_id, barcode, item_id, mode) VALUES (${session.userId}, ${code}, ${item.id}, 'count')`,
        sql`UPDATE inventory.stock_count_lines SET counted_qty = COALESCE(counted_qty, 0) + 1
             WHERE count_id = ${body.count_id} AND item_id = ${item.id} RETURNING counted_qty::float8 AS counted_qty`,
      ])
      if (!upd.length) throw new HttpError(422, 'สินค้านี้ไม่อยู่ในรอบตรวจนับนี้')
      counted = upd[0].counted_qty
    } else {
      await sql`INSERT INTO inventory.scan_events (user_id, barcode, item_id, mode) VALUES (${session.userId}, ${code}, ${item.id}, 'lookup')`
    }
    const [stock] = await loadStock(item.id)
    return { item: stock, counted_qty: counted }
  }, {
    body: t.Object({ barcode: t.String({ minLength: 1, maxLength: 64 }), mode: t.Union([t.Literal('lookup'), t.Literal('count')]), count_id: t.Optional(UUID) }),
  })
