import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { audit, type Ctx } from './audit'
import { prepareRequest } from './approval'
import { nextNo, retryNo } from './docNo'
import { USABLE_SUPPLIER, VAT_RATE, round2 } from './rules'

export type Supplier = { id: string; name: string; tax_id: string | null; address: string | null; status: string; lead_time_days: number; payment_terms_id: string | null }
export type PoLine = { item_id: string; name: string; uom: string; qty: number; price: number }

export async function loadSupplier(id: string): Promise<Supplier> {
  const [s] = await sql`
    SELECT s.party_id AS id, p.name, p.tax_id, p.address, s.status, s.lead_time_days, s.payment_terms_id
      FROM master.suppliers s JOIN master.parties p ON p.id = s.party_id WHERE s.party_id = ${id} AND p.active`
  if (!s) throw new HttpError(404, 'ไม่พบซัพพลายเออร์')
  if (!USABLE_SUPPLIER.includes(s.status)) throw new HttpError(409, `ซัพพลายเออร์ "${s.name}" ยังออก PO ไม่ได้ (รออนุมัติหรือถูกระงับ)`)
  return s as Supplier
}

/** แปลงบรรทัดของ PR/RFQ เป็นบรรทัด PO — po_lines ต้องมี item_id จึงรองรับเฉพาะสินค้าที่อยู่ในทะเบียน */
export async function toPoLines(raw: { item_id: string | null; description: string; uom: string; qty: number; price: number }[]): Promise<PoLine[]> {
  if (!raw.length) throw new HttpError(422, 'เอกสารนี้ไม่มีรายการสินค้า')
  if (raw.some((l) => !l.item_id)) throw new HttpError(422, 'มีรายการที่ยังไม่ระบุรหัสสินค้า (บริการ/ของนอกทะเบียน) — ออก PO จากหน้านี้ไม่ได้')
  const items = await sql`SELECT id, name FROM master.items WHERE id = ANY(${raw.map((l) => l.item_id as string)}::uuid[])`
  const name = new Map(items.map((i) => [i.id as string, i.name as string]))
  return raw.map((l) => ({ item_id: l.item_id as string, name: name.get(l.item_id as string) ?? l.description, uom: l.uom, qty: Number(l.qty), price: Number(l.price) }))
}

export async function userBranch(userId: string, preferred?: string | null): Promise<string> {
  if (preferred) return preferred
  const [u] = await sql`SELECT branch_id FROM platform.users WHERE id = ${userId}`
  if (!u?.branch_id) throw new HttpError(422, 'ไม่ทราบสาขา — ผู้ใช้และใบขอซื้อไม่ได้ระบุสาขา')
  return u.branch_id as string
}

/**
 * ออก PO สถานะ 'pending_approval' + คำขออนุมัติตามวงเงิน (ก่อน VAT) + audit ใน transaction เดียว
 * extra() ใส่คำสั่งเพิ่มของผู้เรียก (อัปเดต PR / ปิด RFQ / doc_links) ให้อยู่ใน transaction เดียวกัน
 */
export async function issuePo(
  ctx: Ctx,
  a: {
    supplier: Supplier; lines: PoLine[]; branchId: string; prId?: string | null; rfqQuoteId?: string | null
    paymentTermsId?: string | null; leadDays?: number; auditAction: string; auditExtra?: Record<string, unknown>
    extra?: (po: { id: string; doc_no: string }) => any[]
  },
) {
  const subtotal = round2(a.lines.reduce((s, l) => s + round2(l.qty * l.price), 0))
  if (!(subtotal > 0)) throw new HttpError(422, 'มูลค่า PO เป็น 0 — ราคาประเมินในใบขอซื้อยังเป็น 0 กรุณาให้ผู้ขอระบุราคาก่อน')
  const vat = round2(subtotal * VAT_RATE), total = round2(subtotal + vat)
  const lines = JSON.stringify(a.lines.map((l, i) => ({ n: i + 1, item: l.item_id, name: l.name, uom: l.uom, qty: l.qty, price: l.price })))
  const termsId = a.paymentTermsId ?? a.supplier.payment_terms_id ?? null
  const lead = a.leadDays ?? a.supplier.lead_time_days ?? 0
  const id = crypto.randomUUID()
  return retryNo(async () => {
    const doc_no = await nextNo('PO')
    const req = await prepareRequest(ctx, {
      type: 'PO', amount: subtotal, branchId: a.branchId, refTable: 'purchasing.purchase_orders', refId: id,
      payload: { summary: `${doc_no} · ${a.supplier.name}`, doc_no, supplier: a.supplier.name, subtotal, total },
    })
    await sql.transaction([
      ...req.queries,
      sql`INSERT INTO purchasing.purchase_orders (id, doc_no, supplier_id, party_name_snap, party_tax_id_snap, party_address_snap, pr_id, rfq_quote_id,
            branch_id, buyer_id, order_date, expected_date, payment_terms_id, status, vat_rate, subtotal, vat_amount, total, approval_request_id)
          VALUES (${id}, ${doc_no}, ${a.supplier.id}, ${a.supplier.name}, ${a.supplier.tax_id}, ${a.supplier.address}, ${a.prId ?? null}, ${a.rfqQuoteId ?? null},
            ${a.branchId}, ${ctx.session.userId}, current_date, current_date + ${lead}::int, ${termsId}, 'pending_approval', ${VAT_RATE}, ${subtotal}, ${vat}, ${total}, ${req.id})`,
      sql`INSERT INTO purchasing.po_lines (po_id, line_no, item_id, item_name_snap, uom_snap, qty, unit_price_snap)
          SELECT ${id}::uuid, x.n, x.item, x.name, x.uom, x.qty, x.price
            FROM jsonb_to_recordset(${lines}::jsonb) AS x(n int, item uuid, name text, uom text, qty numeric, price numeric)`,
      ...(a.extra?.({ id, doc_no }) ?? []),
      audit(ctx, { action: a.auditAction, table: 'purchasing.purchase_orders', id, ref: doc_no,
        after: { supplier: a.supplier.name, subtotal, total, lines: a.lines.length, request: req.request_no, route: req.route, ...a.auditExtra }, risk: 'medium' }),
    ])
    return { id, doc_no, subtotal, total, request_no: req.request_no, route: req.route }
  })
}
