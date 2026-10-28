import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { needWrite, warehouseOnly } from '../guard'
import { audit } from '../lib/audit'
import { approvalSteps, requestQueries } from '../lib/approval'
import { withDocNo } from '../lib/docNo'
import { QTY0, ReasonCode, UUID, assertWarehouse, pg } from '../lib/rules'

/**
 * ตรวจนับสต็อก: เปิดรอบ (ถ่ายยอดระบบ ณ ตอนเปิด) → กรอก/สแกนยอดนับ → ส่งผล
 * คลัง "ไม่ปรับยอดสต็อกเอง" — ส่งผลแล้วระบบสร้างคำขอ COUNT_ADJUST ให้ผู้จัดการอนุมัติตามนโยบายที่ Admin ตั้งไว้
 */
const LINES = (countId: string) => sql`
  SELECT l.id, l.item_id, i.sku, i.name, i.uom, l.system_qty::float8 AS system_qty, l.counted_qty::float8 AS counted_qty,
         l.diff_qty::float8 AS diff_qty, l.reason_code,
         (SELECT bn.code FROM inventory.stock_movements m JOIN master.bins bn ON bn.id = m.bin_id WHERE m.item_id = l.item_id ORDER BY m.id DESC LIMIT 1) AS location
    FROM inventory.stock_count_lines l JOIN master.items i ON i.id = l.item_id
   WHERE l.count_id = ${countId} ORDER BY i.sku`

async function loadCount(id: string) {
  const [c] = await sql`SELECT id, doc_no, warehouse_id, status FROM inventory.stock_counts WHERE id = ${id}`
  if (!c) throw new HttpError(404, 'ไม่พบรอบตรวจนับ')
  return c as { id: string; doc_no: string; warehouse_id: string; status: string }
}

export const countRoutes = new Elysia()
  .use(warehouseOnly)
  // รอบล่าสุดของคลัง (เปิดอยู่/ส่งแล้ว/ผลอนุมัติ) พร้อมรายการ
  .get('/counts/current', async ({ query }) => {
    const [c] = await sql`
      SELECT c.id, c.doc_no, c.status, c.created_at, c.submitted_at, w.name AS warehouse_name, r.request_no
        FROM inventory.stock_counts c JOIN master.warehouses w ON w.id = c.warehouse_id
        LEFT JOIN platform.requests r ON r.id = c.approval_request_id
       WHERE c.warehouse_id = ${query.warehouse_id} ORDER BY c.created_at DESC LIMIT 1`
    return c ? { count: c, lines: await LINES(c.id) } : { count: null, lines: [] }
  }, { query: t.Object({ warehouse_id: UUID }) })

  .post('/counts', async ({ body, session, ip }) => {
    const wh = await assertWarehouse(body.warehouse_id)
    if ((await sql`SELECT 1 FROM inventory.stock_counts WHERE warehouse_id = ${wh.id} AND status IN ('open', 'submitted') LIMIT 1`).length)
      throw new HttpError(409, 'คลังนี้มีรอบตรวจนับที่ยังไม่เสร็จ (กำลังนับ หรือรออนุมัติ)')
    const [n] = await sql`SELECT count(*)::int AS n FROM inventory.stock_balances b JOIN master.items i ON i.id = b.item_id AND i.active WHERE b.warehouse_id = ${wh.id}`
    if (!n.n) throw new HttpError(409, 'คลังนี้ยังไม่มีสินค้าให้ตรวจนับ')
    const id = crypto.randomUUID()
    return await pg(() => withDocNo('CNT', async (docNo) => {
      await sql.transaction([
        sql`INSERT INTO inventory.stock_counts (id, doc_no, warehouse_id, created_by) VALUES (${id}, ${docNo}, ${wh.id}, ${session.userId})`,
        sql`INSERT INTO inventory.stock_count_lines (count_id, item_id, system_qty)
            SELECT ${id}, b.item_id, b.on_hand FROM inventory.stock_balances b JOIN master.items i ON i.id = b.item_id AND i.active WHERE b.warehouse_id = ${wh.id}`,
        audit({ session, ip }, { action: 'open_count', table: 'inventory.stock_counts', id, ref: docNo, after: { warehouse: wh.code, items: n.n } }),
      ])
      return { id, doc_no: docNo }
    }))
  }, { beforeHandle: needWrite, body: t.Object({ warehouse_id: UUID }) })

  // บันทึกยอดนับ (ร่าง) — ส่งมาทั้งชุดหรือเฉพาะแถวที่แก้ก็ได้ · ถ้ายอดนับเท่ายอดระบบ เหตุผลจะถูกล้าง
  .put('/counts/:id/lines', async ({ params, body }) => {
    const c = await loadCount(params.id)
    if (c.status !== 'open') throw new HttpError(409, 'รอบนี้ส่งผลแล้ว แก้ไขไม่ได้')
    const json = JSON.stringify(body.lines)
    await sql`
      UPDATE inventory.stock_count_lines l
         SET counted_qty = x.counted_qty,
             reason_code = CASE WHEN x.counted_qty IS NULL OR x.counted_qty = l.system_qty THEN NULL ELSE x.reason_code END
        FROM jsonb_to_recordset(${json}::jsonb) AS x(id uuid, counted_qty numeric, reason_code text)
       WHERE l.id = x.id AND l.count_id = ${c.id}`
    return { ok: true }
  }, {
    beforeHandle: needWrite, params: t.Object({ id: UUID }),
    body: t.Object({ lines: t.Array(t.Object({ id: UUID, counted_qty: t.Union([QTY0, t.Null()]), reason_code: t.Optional(t.Union([ReasonCode, t.Null()])) }), { minItems: 1, maxItems: 2000 }) }),
  })

  .post('/counts/:id/submit', async ({ params, session, ip }) => {
    const c = await loadCount(params.id)
    if (c.status !== 'open') throw new HttpError(409, 'รอบนี้ส่งผลไปแล้ว')
    const lines = await sql`SELECT i.sku, l.system_qty::float8 AS system_qty, l.counted_qty::float8 AS counted_qty, l.reason_code
                              FROM inventory.stock_count_lines l JOIN master.items i ON i.id = l.item_id WHERE l.count_id = ${c.id}`
    const missing = lines.filter((l) => l.counted_qty == null)
    if (missing.length) throw new HttpError(422, `ยังไม่ได้กรอกยอดนับ ${missing.length} รายการ (${missing.slice(0, 3).map((l) => l.sku).join(', ')}${missing.length > 3 ? '…' : ''})`)
    const diffs = lines.filter((l) => l.counted_qty !== l.system_qty)
    const noReason = diffs.filter((l) => !l.reason_code)
    if (noReason.length) throw new HttpError(422, `ระบุสาเหตุของผลต่างให้ครบ (ขาด ${noReason.length} รายการ: ${noReason.slice(0, 3).map((l) => l.sku).join(', ')})`)

    const [w] = await sql`SELECT code, branch_id FROM master.warehouses WHERE id = ${c.warehouse_id}`
    // คลังไม่เห็นราคา/ต้นทุน จึงยื่นด้วยมูลค่า 0 — นโยบาย COUNT_ADJUST ควรตั้งช่วงวงเงินเริ่มที่ 0 (ดู PATCHES.md ข้อ 5)
    const steps = await approvalSteps('COUNT_ADJUST', 0)
    const ctx = { session, ip }
    return await pg(() => withDocNo('REQ', async (requestNo) => {
      const req = requestQueries(ctx, {
        type: 'COUNT_ADJUST', requestNo, amount: 0, branchId: w.branch_id, refTable: 'inventory.stock_counts', refId: c.id,
        payload: { summary: `ผลตรวจนับ ${c.doc_no} (${w.code}) — ผลต่าง ${diffs.length} จาก ${lines.length} รายการ`, count_id: c.id, count_doc_no: c.doc_no, diff_lines: diffs.length, total_lines: lines.length },
      }, steps)
      await sql.transaction([
        ...req.queries,
        sql`UPDATE inventory.stock_counts SET status = 'submitted', approval_request_id = ${req.id}, submitted_at = now() WHERE id = ${c.id} AND status = 'open'`,
        audit(ctx, { action: 'submit_count', table: 'inventory.stock_counts', id: c.id, ref: c.doc_no, after: { request: requestNo, lines: lines.length, diff_lines: diffs.length }, risk: diffs.length ? 'medium' : 'low' }),
      ])
      return { ok: true, request_no: requestNo, diff_lines: diffs.length }
    }))
  }, { beforeHandle: needWrite, params: t.Object({ id: UUID }) })
