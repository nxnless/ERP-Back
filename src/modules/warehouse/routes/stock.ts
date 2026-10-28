import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { warehouseOnly } from '../guard'
import { loadStock } from '../lib/stock'
import { RECEIVABLE } from '../lib/rules'

export const stockRoutes = new Elysia()
  .use(warehouseOnly)
  // คลัง + ตำแหน่งจัดเก็บ สำหรับ dropdown ในฟอร์ม
  .get('/meta', async () => ({
    warehouses: await sql`SELECT id, code, name FROM master.warehouses WHERE active ORDER BY code`,
    bins: await sql`SELECT b.id, b.code, b.warehouse_id FROM master.bins b JOIN master.warehouses w ON w.id = b.warehouse_id WHERE w.active ORDER BY b.code`,
  }))

  // ระดับสต็อกรายสินค้า (จำนวนล้วน ไม่มีราคา/ต้นทุน)
  .get('/stock', async () => {
    const [warehouses, items, [po]] = await Promise.all([
      sql`SELECT id, code, name FROM master.warehouses WHERE active ORDER BY code`,
      loadStock(),
      sql`SELECT count(*)::int AS n FROM purchasing.purchase_orders p
           WHERE p.status = ANY(${RECEIVABLE}::text[]) AND EXISTS (SELECT 1 FROM purchasing.po_lines l WHERE l.po_id = p.id AND l.qty > l.qty_received)`,
    ])
    return { warehouses, items, low_count: items.filter((i) => i.status === 'low').length, pending_pos: po.n as number }
  })

  // ประวัติการเคลื่อนไหวสต็อก (ใหม่สุดก่อน)
  .get('/movements', async ({ query }) => {
    const limit = Math.min(query.limit ?? 50, 200), offset = query.offset ?? 0
    const rows = await sql`
      SELECT m.id, m.created_at, m.movement_type, m.doc_no, m.qty::float8 AS qty, i.sku, i.name AS item_name, i.uom,
             w.name AS warehouse_name, u.display_name AS actor_name
        FROM inventory.stock_movements m
        JOIN master.items i ON i.id = m.item_id JOIN master.warehouses w ON w.id = m.warehouse_id
        LEFT JOIN platform.users u ON u.id = m.created_by
       ORDER BY m.id DESC LIMIT ${limit + 1} OFFSET ${offset}`
    return { rows: rows.slice(0, limit), has_more: rows.length > limit, limit, offset }
  }, { query: t.Object({ limit: t.Optional(t.Numeric()), offset: t.Optional(t.Numeric()) }) })
