import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { moduleLevel, purchasingOnly } from '../guard'
import { audit } from '../lib/audit'
import { prepareRequest } from '../lib/approval'
import { nextNo, retryNo } from '../lib/docNo'
import { userBranch } from '../lib/po'
import { INCOMING_PO, UUID, round2 } from '../lib/rules'

export const reorderRoutes = new Elysia()
  .use(purchasingOnly)

  // จุดสั่งซื้อซ้ำ: พร้อมใช้ = คงเหลือ − ที่จองแล้ว · "ต้องสั่ง" = พร้อมใช้ต่ำกว่าจุดสั่งซื้อ และรวม PO ที่กำลังมาแล้วก็ยังต่ำกว่า
  .get('/reorder', async ({ session }) => {
    if ((await moduleLevel(session.roles, 'inventory')) < 1) throw new HttpError(403, 'ไม่มีสิทธิ์ดูสต็อก')
    const rows = await sql`
      WITH bal AS (SELECT item_id, sum(on_hand) AS on_hand FROM inventory.stock_balances GROUP BY item_id),
           res AS (SELECT item_id, sum(qty) AS reserved FROM inventory.stock_reservations WHERE released_at IS NULL GROUP BY item_id),
           inc AS (SELECT l.item_id, sum(l.qty - l.qty_received) AS incoming FROM purchasing.po_lines l JOIN purchasing.purchase_orders po ON po.id = l.po_id
                    WHERE po.status = ANY(${INCOMING_PO}::text[]) GROUP BY l.item_id),
           prq AS (SELECT l.item_id, sum(l.qty) AS open_pr FROM purchasing.pr_lines l JOIN purchasing.purchase_requisitions pr ON pr.id = l.pr_id
                    WHERE pr.status IN ('pending_approval','approved') AND l.item_id IS NOT NULL GROUP BY l.item_id),
           lp AS (SELECT DISTINCT ON (l.item_id) l.item_id, po.party_name_snap AS supplier_name, s.lead_time_days
                    FROM purchasing.po_lines l JOIN purchasing.purchase_orders po ON po.id = l.po_id LEFT JOIN master.suppliers s ON s.party_id = po.supplier_id
                   WHERE po.status <> 'cancelled' ORDER BY l.item_id, po.order_date DESC, po.created_at DESC)
      SELECT i.id, i.sku, i.name, i.uom, i.reorder_point::float8 AS reorder_point, i.avg_daily_use::float8 AS avg_daily_use,
             (COALESCE(bal.on_hand, 0) - COALESCE(res.reserved, 0))::float8 AS available,
             COALESCE(inc.incoming, 0)::float8 AS incoming, COALESCE(prq.open_pr, 0)::float8 AS open_pr,
             lp.supplier_name, lp.lead_time_days
        FROM master.items i LEFT JOIN bal ON bal.item_id = i.id LEFT JOIN res ON res.item_id = i.id LEFT JOIN inc ON inc.item_id = i.id
        LEFT JOIN prq ON prq.item_id = i.id LEFT JOIN lp ON lp.item_id = i.id
       WHERE i.active AND i.reorder_point > 0 ORDER BY i.sku`
    return rows.map((r) => {
      const avail = r.available as number, rop = r.reorder_point as number, inc = r.incoming as number
      const below = avail < rop, low = below && avail + inc < rop
      const days = (r.avg_daily_use as number) > 0 ? Math.floor(Math.max(avail, 0) / (r.avg_daily_use as number)) : null
      return {
        ...r, days, status: low ? 'low' : below ? 'incoming' : 'ok',
        suggest: low ? Math.max(Math.ceil((rop * 2 - avail - inc) / 10) * 10, 0) : 0,
        urgent: days != null && r.lead_time_days != null && days < (r.lead_time_days as number), // สต็อกหมดก่อนของใหม่จะมาถึง
      }
    })
  })

  // สร้างใบขอซื้อเติมสต็อก → ส่งอนุมัติตามนโยบาย PR (หัวหน้าแผนก) ราคาประเมิน = ราคา PO ล่าสุด หรือต้นทุนล่าสุด
  .post('/reorder/:itemId/pr', async ({ params, body, session, ip }) => {
    const [it] = await sql`
      SELECT i.id, i.name, i.uom,
             (SELECT l.unit_price_snap FROM purchasing.po_lines l JOIN purchasing.purchase_orders po ON po.id = l.po_id
               WHERE l.item_id = i.id AND po.status <> 'cancelled' ORDER BY po.order_date DESC, po.created_at DESC LIMIT 1)::float8 AS last_price,
             (SELECT c.cost FROM master.item_costs c WHERE c.item_id = i.id ORDER BY c.valid_from DESC LIMIT 1)::float8 AS last_cost,
             (SELECT s.lead_time_days FROM purchasing.po_lines l JOIN purchasing.purchase_orders po ON po.id = l.po_id JOIN master.suppliers s ON s.party_id = po.supplier_id
               WHERE l.item_id = i.id AND po.status <> 'cancelled' ORDER BY po.order_date DESC, po.created_at DESC LIMIT 1) AS lead_days
        FROM master.items i WHERE i.id = ${params.itemId} AND i.active`
    if (!it) throw new HttpError(404, 'ไม่พบสินค้า')
    if ((await sql`SELECT 1 FROM purchasing.pr_lines l JOIN purchasing.purchase_requisitions pr ON pr.id = l.pr_id WHERE l.item_id = ${it.id} AND pr.status IN ('pending_approval','approved')`).length)
      throw new HttpError(409, 'สินค้านี้มีใบขอซื้อที่รอดำเนินการอยู่แล้ว')
    const ctx = { session, ip }, id = crypto.randomUUID()
    const price = (it.last_price ?? it.last_cost ?? 0) as number, amount = round2(body.qty * price)
    const branchId = await userBranch(session.userId)
    return retryNo(async () => {
      const doc_no = await nextNo('PR')
      const req = await prepareRequest(ctx, {
        type: 'PR', amount, branchId, refTable: 'purchasing.purchase_requisitions', refId: id,
        payload: { summary: `${doc_no} · ${it.name} ${body.qty} ${it.uom}`, doc_no, item: it.name, qty: body.qty, est_total: amount },
      })
      await sql.transaction([
        ...req.queries,
        sql`INSERT INTO purchasing.purchase_requisitions (id, doc_no, requester_id, branch_id, need_by, reason, status, approval_request_id)
            VALUES (${id}, ${doc_no}, ${session.userId}, ${branchId}, current_date + ${it.lead_days ?? null}::int, 'จัดซื้อ (เติมสต็อก) — ต่ำกว่าจุดสั่งซื้อ', 'pending_approval', ${req.id})`,
        sql`INSERT INTO purchasing.pr_lines (pr_id, line_no, item_id, description, qty, uom, est_unit_price) VALUES (${id}, 1, ${it.id}, ${it.name}, ${body.qty}, ${it.uom}, ${price})`,
        audit(ctx, { action: 'create_pr_reorder', table: 'purchasing.purchase_requisitions', id, ref: doc_no, after: { item: it.name, qty: body.qty, est_total: amount, request: req.request_no, route: req.route } }),
      ])
      return { id, doc_no, route: req.route }
    })
  }, { params: t.Object({ itemId: UUID }), body: t.Object({ qty: t.Number({ minimum: 0.001, maximum: 1_000_000 }) }) })
