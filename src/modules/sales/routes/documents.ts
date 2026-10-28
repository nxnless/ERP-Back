import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import type { Session } from '../../../auth/session'
import { moduleAccess } from '../guard'
import { audit } from '../lib/audit'
import { planSteps, prepareRequest } from '../lib/approval'
import { creditOf, hasValidException } from '../lib/credit'
import { nextNo, withRetry } from '../lib/docNo'
import { DISCOUNT_FREE_PCT, EXEC_QUOTE_THRESHOLD, MAX_DISCOUNT_PCT, MAX_LINES, QUOTE_VALID_DAYS, UUID, VAT_RATE, lineTotal } from '../lib/rules'

/**
 * ใบเสนอราคา → ใบสั่งขาย → ใบส่งของ
 * เห็นเอกสารของตนและทีม (สาขาเดียวกัน) แต่ "ดำเนินการ" ได้เฉพาะเอกสารที่ตนเป็นผู้ขาย
 * หมายเหตุ: ไม่ตัดสต็อกและไม่ออกใบแจ้งหนี้ — เป็นหน้าที่ฝั่งคลังสินค้า/บัญชี
 */

// สถานะที่ "ใช้งานจริง" ของใบเสนอราคา: อ่านผลอนุมัติจาก platform.requests (ผู้อนุมัติไม่ต้องมาแก้ตารางของฝ่ายขาย) + หมดอายุอัตโนมัติ
const PENDING = ['pending_discount_approval', 'pending_exec_approval']
const QT_STATUS = `CASE WHEN q.status IN ('pending_discount_approval','pending_exec_approval') AND r.status = 'approved' THEN 'draft'
  WHEN q.status IN ('pending_discount_approval','pending_exec_approval') AND r.status IN ('rejected','cancelled') THEN 'approval_rejected'
  WHEN q.status = 'sent' AND q.valid_until < current_date THEN 'expired' ELSE q.status END`
const DOC_LABEL: Record<string, string> = { QUOTATION: 'ใบเสนอราคา', QUOTATION_DISCOUNT: 'ส่วนลดใบเสนอราคา' }

type Act = { params: { id: string }; session: Session; ip: string | null; teamIds: string[] }

async function myQuotation(id: string, teamIds: string[]) {
  const [q] = await sql.query(
    `SELECT q.id, q.doc_no, q.customer_id, q.party_name_snap, q.party_tax_id_snap, q.party_address_snap, q.branch_id, q.salesperson_id,
            q.subtotal, q.vat_amount, q.total, q.vat_rate, ${QT_STATUS} AS eff
       FROM sales.quotations q LEFT JOIN platform.requests r ON r.id = q.approval_request_id WHERE q.id = $1`, [id])
  if (!q) throw new HttpError(404, 'ไม่พบใบเสนอราคา')
  if (!teamIds.includes(q.salesperson_id)) throw new HttpError(403, 'ดำเนินการได้เฉพาะเอกสารของตนเอง (หัวหน้าแผนก: รวมของลูกทีมในแผนก)')
  return q
}

/** เปลี่ยนสถานะใบเสนอราคาทีละขั้น (ส่งลูกค้า / ลูกค้าตอบรับ / ลูกค้าปฏิเสธ) */
const quoteStep = (from: string, to: string, action: string) => async ({ params, session, ip, teamIds }: Act) => {
  const q = await myQuotation(params.id, teamIds)
  if (q.eff !== from) throw new HttpError(409, 'สถานะปัจจุบันทำรายการนี้ไม่ได้')
  const stored = from === 'draft' ? ['draft', ...PENDING] : [from]
  await sql.transaction([
    sql`UPDATE sales.quotations SET status = ${to}, updated_at = now() WHERE id = ${q.id} AND status = ANY(${stored}::text[])`,
    audit({ session, ip }, { action, table: 'sales.quotations', id: q.id, ref: q.doc_no, before: { status: q.eff }, after: { status: to } }),
  ])
  return { ok: true }
}

const Line = t.Object({
  item_id: UUID, qty: t.Number({ exclusiveMinimum: 0, maximum: 1_000_000 }), discount_pct: t.Optional(t.Number({ minimum: 0, maximum: MAX_DISCOUNT_PCT })),
})
const IdParam = { params: t.Object({ id: UUID }) }

export const documentRoutes = new Elysia()
  .use(moduleAccess('sales'))
  .get('/documents', async ({ session, branchId, teamIds }) => await sql.query(
    `SELECT * FROM (
       SELECT q.id, 'QT' AS type, q.doc_no, q.party_name_snap AS customer, q.subtotal::float8 AS amount,
              COALESCE((SELECT max(l.discount_pct) FROM sales.quotation_lines l WHERE l.quotation_id = q.id), 0)::float8 AS discount,
              ${QT_STATUS} AS status, NULL::text AS ref, q.created_at, (q.salesperson_id = $1) AS own, (q.salesperson_id = ANY($3::uuid[])) AS mine, u.display_name AS owner_name
         FROM sales.quotations q LEFT JOIN platform.requests r ON r.id = q.approval_request_id LEFT JOIN platform.users u ON u.id = q.salesperson_id
        WHERE q.salesperson_id = ANY($3::uuid[]) OR q.branch_id = $2::uuid
       UNION ALL
       SELECT o.id, 'SO', o.doc_no, o.party_name_snap, o.subtotal::float8,
              COALESCE((SELECT max(l.discount_pct) FROM sales.sales_order_lines l WHERE l.sales_order_id = o.id), 0)::float8,
              o.status, qq.doc_no, o.created_at, (o.salesperson_id = $1), (o.salesperson_id = ANY($3::uuid[])), u.display_name
         FROM sales.sales_orders o LEFT JOIN sales.quotations qq ON qq.id = o.quotation_id LEFT JOIN platform.users u ON u.id = o.salesperson_id
        WHERE o.salesperson_id = ANY($3::uuid[]) OR o.branch_id = $2::uuid
       UNION ALL
       SELECT d.id, 'DN', d.doc_no, d.party_name_snap, o.subtotal::float8, 0::float8, d.status, o.doc_no, d.created_at, (o.salesperson_id = $1), (o.salesperson_id = ANY($3::uuid[])), u.display_name
         FROM sales.delivery_notes d JOIN sales.sales_orders o ON o.id = d.sales_order_id LEFT JOIN platform.users u ON u.id = o.salesperson_id
        WHERE o.salesperson_id = ANY($3::uuid[]) OR o.branch_id = $2::uuid
     ) x ORDER BY created_at DESC LIMIT 300`, [session.userId, branchId, teamIds]))

  // ---------- สร้างใบเสนอราคา: ราคามาจาก Price List ของลูกค้า (ไม่รับราคาจากหน้าบ้าน) ----------
  .post('/quotations', async ({ body, session, ip, branchId, teamIds }) => {
    if (!branchId) throw new HttpError(422, 'บัญชีของคุณยังไม่ได้กำหนดสาขา — ติดต่อ Admin')
    const [c] = await sql`
      SELECT c.party_id, c.status, c.price_list_id, p.name, p.tax_id, p.address
        FROM master.customers c JOIN master.parties p ON p.id = c.party_id
       WHERE c.party_id = ${body.customer_id} AND (c.owner_user_id = ANY(${teamIds}::uuid[]) OR c.branch_id = ${branchId}::uuid)`
    if (!c) throw new HttpError(404, 'ไม่พบลูกค้าในความดูแล')
    if (c.status === 'inactive') throw new HttpError(409, 'ลูกค้ารายนี้ปิดใช้งานแล้ว')

    const ids = [...new Set(body.lines.map((l) => l.item_id))]
    const items = await sql`
      SELECT i.id, i.name, i.uom, i.active,
             COALESCE(
               (SELECT pi.price::float8 FROM master.price_list_items pi WHERE pi.item_id = i.id AND pi.price_list_id = ${c.price_list_id}::uuid
                   AND pi.valid_from <= current_date AND (pi.valid_to IS NULL OR pi.valid_to >= current_date) ORDER BY pi.valid_from DESC LIMIT 1),
               (SELECT pi.price::float8 FROM master.price_list_items pi JOIN master.price_lists pl ON pl.id = pi.price_list_id AND pl.is_default
                 WHERE pi.item_id = i.id AND pi.valid_from <= current_date AND (pi.valid_to IS NULL OR pi.valid_to >= current_date) ORDER BY pi.valid_from DESC LIMIT 1)) AS price
        FROM master.items i WHERE i.id = ANY(${ids}::uuid[])`
    const byId = new Map<string, any>(items.map((i: any) => [i.id as string, i]))
    const lines = body.lines.map((l, k) => {
      const it = byId.get(l.item_id)
      if (!it || !it.active) throw new HttpError(422, 'มีสินค้าที่ไม่พบหรือปิดใช้งาน')
      if (it.price == null) throw new HttpError(422, `สินค้า "${it.name}" ยังไม่มีราคาใน Price List`)
      return { n: k + 1, item: it.id as string, name: it.name as string, uom: it.uom as string, qty: l.qty, price: it.price as number, disc: l.discount_pct ?? 0 }
    })
    const subtotal = lines.reduce((s, l) => s + lineTotal(l.qty, l.price, l.disc), 0)
    const maxDisc = Math.max(...lines.map((l) => l.disc))

    // ส่วนลดเกินเกณฑ์ → ผู้จัดการ · มูลค่าเกินเกณฑ์ → ผู้บริหาร (ผู้อนุมัติจริงมาจากนโยบายที่ Admin ตั้ง — ไม่มีนโยบาย = ปิดทางไว้ ไม่ปล่อยผ่าน)
    const need = [...(maxDisc > DISCOUNT_FREE_PCT ? ['QUOTATION_DISCOUNT'] : []), ...(subtotal > EXEC_QUOTE_THRESHOLD ? ['QUOTATION'] : [])]
    const roleIds: string[] = []
    for (const ty of need) {
      const r = await planSteps([ty], subtotal)
      if (!r.length) throw new HttpError(422, `ยังไม่มีนโยบายอนุมัติ "${DOC_LABEL[ty]}" ที่มูลค่านี้ — แจ้ง Admin ตั้งค่า Workflow อนุมัติ`)
      for (const x of r) if (!roleIds.includes(x)) roleIds.push(x)
    }
    const status = need.includes('QUOTATION_DISCOUNT') ? 'pending_discount_approval' : need.length ? 'pending_exec_approval' : 'draft'
    const id = crypto.randomUUID()

    const doc_no = await withRetry(async () => {
      const doc_no = await nextNo('sales.quotations', 'QT')
      const req = roleIds.length
        ? await prepareRequest({ session, ip }, {
            type: need[0], amount: subtotal, refTable: 'sales.quotations', refId: id, roleIds, branchId,
            payload: { summary: `${doc_no} · ${c.name}`, doc_no, customer: c.name, subtotal, max_discount_pct: maxDisc },
          })
        : null
      await sql.transaction([
        ...(req?.queries ?? []),
        sql`INSERT INTO sales.quotations (id, doc_no, customer_id, party_name_snap, party_tax_id_snap, party_address_snap, branch_id, salesperson_id,
                                          valid_until, status, vat_rate, approval_request_id, note)
            VALUES (${id}, ${doc_no}, ${c.party_id}, ${c.name}, ${c.tax_id}, ${c.address}, ${branchId}, ${session.userId},
                    current_date + ${QUOTE_VALID_DAYS}::int, ${status}, ${VAT_RATE}, ${req?.id ?? null}, ${body.note?.trim() || null})`,
        sql`INSERT INTO sales.quotation_lines (quotation_id, line_no, item_id, item_name_snap, uom_snap, qty, unit_price_snap, discount_pct)
            SELECT ${id}, x.n, x.item, x.name, x.uom, x.qty, x.price, x.disc
              FROM unnest(${lines.map((l) => l.n)}::int[], ${lines.map((l) => l.item)}::uuid[], ${lines.map((l) => l.name)}::text[], ${lines.map((l) => l.uom)}::text[],
                          ${lines.map((l) => l.qty)}::numeric[], ${lines.map((l) => l.price)}::numeric[], ${lines.map((l) => l.disc)}::numeric[]) AS x(n, item, name, uom, qty, price, disc)`,
        // ยอดรวมให้ DB รวมจาก line_total เอง (ปัดสตางค์ตรงกับ generated column)
        sql`UPDATE sales.quotations q SET subtotal = s.sub, vat_amount = round(s.sub * q.vat_rate, 2), total = s.sub + round(s.sub * q.vat_rate, 2)
              FROM (SELECT COALESCE(sum(line_total), 0) AS sub FROM sales.quotation_lines WHERE quotation_id = ${id}) s WHERE q.id = ${id}`,
        audit({ session, ip }, { action: 'create_quotation', table: 'sales.quotations', id, ref: doc_no, after: { customer: c.name, subtotal, max_discount_pct: maxDisc, status }, risk: need.length ? 'medium' : 'low' }),
      ])
      return doc_no
    })
    return { id, doc_no, status, approval: need.includes('QUOTATION_DISCOUNT') ? 'discount' : need.length ? 'exec' : null }
  }, { body: t.Object({ customer_id: UUID, lines: t.Array(Line, { minItems: 1, maxItems: MAX_LINES }), note: t.Optional(t.String({ maxLength: 300 })) }) })

  .post('/quotations/:id/send', quoteStep('draft', 'sent', 'send_quotation'), IdParam)
  .post('/quotations/:id/accept', quoteStep('sent', 'accepted', 'accept_quotation'), IdParam)
  .post('/quotations/:id/decline', quoteStep('sent', 'declined', 'decline_quotation'), IdParam)

  // ---------- แปลงเป็นใบสั่งขาย: ตรวจเครดิตก่อน (ค้างเกินกำหนด / เกินวงเงิน) ถ้าถูกบล็อกต้องมีคำขอยกเว้นที่อนุมัติแล้ว ----------
  .post('/quotations/:id/convert', async ({ params, session, ip, teamIds }) => {
    const q = await myQuotation(params.id, teamIds)
    if (q.eff !== 'accepted') throw new HttpError(409, 'แปลงได้เฉพาะใบเสนอราคาที่ลูกค้าตอบรับแล้ว')
    const cr = await creditOf(q.customer_id)
    if (!cr) throw new HttpError(404, 'ไม่พบลูกค้า')
    const reason = cr.hold ? 'มียอดค้างชำระเกินกำหนด' : cr.credit_limit > 0 && cr.used + Number(q.total) > cr.credit_limit ? 'ยอดนี้จะเกินวงเงินเครดิต' : null
    const excused = reason ? await hasValidException(q.customer_id, teamIds) : false
    if (reason && !excused) throw new HttpError(409, `${q.party_name_snap} ${reason} — สร้างใบสั่งขายไม่ได้ ให้ยื่นคำขอยกเว้นที่หน้า "ลูกค้า" และรออนุมัติก่อน`)
    const soId = crypto.randomUUID()
    const doc_no = await withRetry(async () => {
      const doc_no = await nextNo('sales.sales_orders', 'SO')
      await sql.transaction([
        sql`INSERT INTO sales.sales_orders (id, doc_no, quotation_id, customer_id, party_name_snap, party_tax_id_snap, party_address_snap, branch_id, salesperson_id,
                                            status, credit_check_ok, vat_rate, subtotal, vat_amount, total)
            VALUES (${soId}, ${doc_no}, ${q.id}, ${q.customer_id}, ${q.party_name_snap}, ${q.party_tax_id_snap}, ${q.party_address_snap}, ${q.branch_id}, ${q.salesperson_id},
                    'approved', ${!reason}, ${q.vat_rate}, ${q.subtotal}, ${q.vat_amount}, ${q.total})`,
        sql`INSERT INTO sales.sales_order_lines (sales_order_id, line_no, item_id, item_name_snap, uom_snap, qty, unit_price_snap, discount_pct)
            SELECT ${soId}, line_no, item_id, item_name_snap, uom_snap, qty, unit_price_snap, discount_pct FROM sales.quotation_lines WHERE quotation_id = ${q.id}`,
        sql`UPDATE sales.quotations SET status = 'converted', updated_at = now() WHERE id = ${q.id}`,
        audit({ session, ip }, { action: 'convert_quotation', table: 'sales.sales_orders', id: soId, ref: doc_no, before: { quotation: q.doc_no },
          after: { quotation: q.doc_no, customer: q.party_name_snap, credit_exception_used: excused, credit_issue: reason }, risk: excused ? 'high' : 'low' }),
      ])
      return doc_no
    })
    return { id: soId, doc_no }
  }, IdParam)

  // ---------- ใบส่งของ: ส่งของที่เหลือทุกรายการ (ยังไม่รองรับส่งบางส่วน) ----------
  .post('/sales-orders/:id/delivery', async ({ params, session, ip, branchId, teamIds }) => {
    const [o] = await sql`SELECT id, doc_no, salesperson_id, status, party_name_snap, party_address_snap FROM sales.sales_orders WHERE id = ${params.id}`
    if (!o) throw new HttpError(404, 'ไม่พบใบสั่งขาย')
    if (!teamIds.includes(o.salesperson_id)) throw new HttpError(403, 'ดำเนินการได้เฉพาะเอกสารของตนเอง (หัวหน้าแผนก: รวมของลูกทีมในแผนก)')
    if (!['approved', 'ready_to_ship', 'partially_shipped'].includes(o.status)) throw new HttpError(409, 'ใบสั่งขายนี้ยังสร้างใบส่งของไม่ได้')
    if (!(await sql`SELECT 1 FROM sales.sales_order_lines WHERE sales_order_id = ${o.id} AND qty > qty_shipped LIMIT 1`).length) throw new HttpError(409, 'ส่งของครบทุกรายการแล้ว')
    const [w] = await sql`SELECT id FROM master.warehouses WHERE active ORDER BY (branch_id IS NOT DISTINCT FROM ${branchId}::uuid) DESC, code LIMIT 1`
    if (!w) throw new HttpError(422, 'ยังไม่มีคลังสินค้าที่ใช้งานอยู่ — ติดต่อ Admin')
    const dnId = crypto.randomUUID()
    const doc_no = await withRetry(async () => {
      const doc_no = await nextNo('sales.delivery_notes', 'DN')
      await sql.transaction([
        sql`INSERT INTO sales.delivery_notes (id, doc_no, sales_order_id, warehouse_id, party_name_snap, party_address_snap, status, shipped_at, created_by)
            VALUES (${dnId}, ${doc_no}, ${o.id}, ${w.id}, ${o.party_name_snap}, ${o.party_address_snap}, 'in_transit', now(), ${session.userId})`,
        sql`INSERT INTO sales.delivery_note_lines (delivery_note_id, so_line_id, item_id, item_name_snap, uom_snap, qty)
            SELECT ${dnId}, id, item_id, item_name_snap, uom_snap, qty - qty_shipped FROM sales.sales_order_lines WHERE sales_order_id = ${o.id} AND qty > qty_shipped`,
        sql`UPDATE sales.sales_order_lines SET qty_shipped = qty WHERE sales_order_id = ${o.id}`,
        sql`UPDATE sales.sales_orders SET status = 'shipped', updated_at = now() WHERE id = ${o.id}`,
        audit({ session, ip }, { action: 'create_delivery_note', table: 'sales.delivery_notes', id: dnId, ref: doc_no, before: { so_status: o.status }, after: { sales_order: o.doc_no, so_status: 'shipped' } }),
      ])
      return doc_no
    })
    return { id: dnId, doc_no }
  }, IdParam)

  .post('/delivery-notes/:id/delivered', async ({ params, session, ip, teamIds }) => {
    const [d] = await sql`SELECT d.id, d.doc_no, d.status, o.salesperson_id FROM sales.delivery_notes d JOIN sales.sales_orders o ON o.id = d.sales_order_id WHERE d.id = ${params.id}`
    if (!d) throw new HttpError(404, 'ไม่พบใบส่งของ')
    if (!teamIds.includes(d.salesperson_id)) throw new HttpError(403, 'ดำเนินการได้เฉพาะเอกสารของตนเอง (หัวหน้าแผนก: รวมของลูกทีมในแผนก)')
    if (d.status !== 'in_transit') throw new HttpError(409, 'บันทึกส่งสำเร็จได้เฉพาะใบส่งของที่กำลังจัดส่ง')
    await sql.transaction([
      sql`UPDATE sales.delivery_notes SET status = 'delivered', delivered_at = now() WHERE id = ${d.id} AND status = 'in_transit'`,
      audit({ session, ip }, { action: 'delivery_confirmed', table: 'sales.delivery_notes', id: d.id, ref: d.doc_no, before: { status: 'in_transit' }, after: { status: 'delivered' } }),
    ])
    return { ok: true }
  }, IdParam)
