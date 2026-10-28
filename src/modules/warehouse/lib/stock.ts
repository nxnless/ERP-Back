import { sql } from '../../../shared/db'
import { RECEIVABLE } from './rules'

/**
 * สต็อกรายสินค้า (ไม่มีราคา/ต้นทุน) — ใช้ร่วมกันระหว่างหน้าระดับสต็อกกับการสแกน
 *  on_hand = { [warehouse_id]: จำนวน } · reserved = จองแล้วทุกคลัง · incoming = ค้างรับจากใบสั่งซื้อที่ยังไม่ครบ
 *  available = รวมทุกคลัง − จอง · status 'low' = ต่ำกว่าจุดสั่งซื้อ "และ" ของที่กำลังมาก็ยังไม่พอ · 'incoming' = ต่ำกว่าแต่มีของกำลังมาพอ
 */
export async function loadStock(itemId: string | null = null) {
  const rows = await sql`
    SELECT i.id, i.sku, i.name, i.uom, i.barcode, i.reorder_point::float8 AS reorder_point,
           COALESCE((SELECT json_object_agg(b.warehouse_id, b.on_hand::float8) FROM inventory.stock_balances b WHERE b.item_id = i.id), '{}'::json) AS on_hand,
           COALESCE((SELECT sum(r.qty) FROM inventory.stock_reservations r WHERE r.item_id = i.id AND r.released_at IS NULL), 0)::float8 AS reserved,
           COALESCE((SELECT sum(l.qty - l.qty_received) FROM purchasing.po_lines l JOIN purchasing.purchase_orders p ON p.id = l.po_id
                      WHERE l.item_id = i.id AND p.status = ANY(${RECEIVABLE}::text[])), 0)::float8 AS incoming,
           (SELECT bn.code FROM inventory.stock_movements m JOIN master.bins bn ON bn.id = m.bin_id WHERE m.item_id = i.id ORDER BY m.id DESC LIMIT 1) AS location
      FROM master.items i
     WHERE i.active AND (${itemId}::uuid IS NULL OR i.id = ${itemId}::uuid)
     ORDER BY i.sku`
  return rows.map((r) => {
    const total = Object.values(r.on_hand as Record<string, number>).reduce((s, n) => s + n, 0)
    const available = total - r.reserved
    const below = available < r.reorder_point
    const status = below && available + r.incoming < r.reorder_point ? 'low' : below ? 'incoming' : 'ok'
    return { ...r, total, available, status } as typeof r & { total: number; available: number; status: 'low' | 'incoming' | 'ok' }
  })
}
