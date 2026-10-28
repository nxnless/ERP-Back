import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { moduleAccess } from '../guard'
import { audit } from '../lib/audit'
import { planSteps, prepareRequest } from '../lib/approval'
import { nextPartyCode, withRetry } from '../lib/docNo'
import { EXCEPTION_VALID_DAYS, NEAR_LIMIT_PCT, NEW_CUSTOMER_CREDIT, RULES, UUID } from '../lib/rules'

const WHY: Record<string, string> = { overdue: 'ค้างชำระเกินกำหนด', limit: 'วงเงินเครดิตเต็ม' }

/**
 * ลูกค้า + Price List — เห็นเฉพาะลูกค้าที่ตนดูแล หรือลูกค้าในสาขาเดียวกัน (ทีม)
 * ห้าม select master.item_costs (ต้นทุน/กำไรขั้นต้น) ในโมดูลนี้
 */
export const customerRoutes = new Elysia()
  .use(moduleAccess('sales'))
  .get('/meta', async ({ isHead }) => ({
    is_head: isHead,
    price_lists: await sql`SELECT id, code, name, is_default FROM master.price_lists ORDER BY is_default DESC, code`,
    payment_terms: await sql`SELECT id, code, name, credit_days FROM master.payment_terms ORDER BY credit_days`,
    rules: RULES,
  }))

  .get('/customers', async ({ session, branchId, teamIds }) => {
    const rows = await sql`
      SELECT c.party_id AS id, p.code, p.name, p.tax_id, c.status, c.price_list_id, pl.code AS price_list_code, pl.name AS price_list_name,
             COALESCE(pt.credit_days, 0)::int AS credit_days, c.credit_limit::float8 AS credit_limit,
             (c.owner_user_id = ${session.userId}) AS own, (c.owner_user_id = ANY(${teamIds}::uuid[])) AS mine, ou.display_name AS owner_name,
             COALESCE((SELECT sum(i.total - i.paid_amount) FROM accounting.invoices i
                        WHERE i.direction = 'AR' AND i.party_id = c.party_id AND i.status IN ('issued','verified','partially_paid')), 0)::float8 AS outstanding,
             COALESCE((SELECT sum(o.total) FROM sales.sales_orders o
                        WHERE o.customer_id = c.party_id AND o.status IN ('approved','ready_to_ship','partially_shipped','shipped')), 0)::float8 AS open_orders,
             EXISTS (SELECT 1 FROM accounting.invoices i WHERE i.direction = 'AR' AND i.party_id = c.party_id AND i.status IN ('issued','verified','partially_paid')
                        AND i.total > i.paid_amount AND i.due_date < current_date - ${RULES.hold_overdue_days}::int) AS overdue_hold,
             (SELECT max(o.order_date) FROM sales.sales_orders o WHERE o.customer_id = c.party_id) AS last_order,
             EXISTS (SELECT 1 FROM platform.requests r WHERE r.type = 'CREDIT_EXCEPTION' AND r.ref_table = 'master.customers' AND r.ref_id = c.party_id
                        AND r.requester_id = ANY(${teamIds}::uuid[]) AND r.status = 'pending') AS exception_pending,
             EXISTS (SELECT 1 FROM platform.requests r WHERE r.type = 'CREDIT_EXCEPTION' AND r.ref_table = 'master.customers' AND r.ref_id = c.party_id
                        AND r.requester_id = ANY(${teamIds}::uuid[]) AND r.status = 'approved' AND r.decided_at >= now() - make_interval(days => ${EXCEPTION_VALID_DAYS}::int)) AS exception_active
        FROM master.customers c
        JOIN master.parties p ON p.id = c.party_id
        LEFT JOIN master.price_lists pl ON pl.id = c.price_list_id
        LEFT JOIN master.payment_terms pt ON pt.id = c.payment_terms_id
        LEFT JOIN platform.users ou ON ou.id = c.owner_user_id
       WHERE c.status <> 'inactive' AND p.active AND (c.owner_user_id = ANY(${teamIds}::uuid[]) OR c.branch_id = ${branchId}::uuid)
       ORDER BY p.name LIMIT 500`
    return rows.map((r) => {
      const used = r.outstanding + r.open_orders
      const hold = r.status === 'credit_hold' || r.overdue_hold
      const pct = r.credit_limit > 0 ? Math.round((used / r.credit_limit) * 100) : used > 0 ? 100 : 0
      return { ...r, used, pct, hold, near_limit: pct >= NEAR_LIMIT_PCT, blocked: hold || (r.credit_limit > 0 && used >= r.credit_limit) }
    })
  })

  // ราคาขายปัจจุบันของทุก Price List (ไม่มีต้นทุน) — ใช้ทั้งหน้า Price List และฟอร์มใบเสนอราคา
  .get('/price-list', async () => ({
    lists: await sql`SELECT id, code, name, is_default FROM master.price_lists ORDER BY is_default DESC, code`,
    items: await sql`
      SELECT i.id, i.sku, i.name, i.uom,
             COALESCE((SELECT json_object_agg(x.price_list_id, x.price) FROM (
                SELECT DISTINCT ON (pi.price_list_id) pi.price_list_id, pi.price::float8 AS price FROM master.price_list_items pi
                 WHERE pi.item_id = i.id AND pi.valid_from <= current_date AND (pi.valid_to IS NULL OR pi.valid_to >= current_date)
                 ORDER BY pi.price_list_id, pi.valid_from DESC) x), '{}'::json) AS prices
        FROM master.items i WHERE i.active ORDER BY i.sku LIMIT 2000`,
  }))

  // เพิ่มลูกค้าใหม่ (ผู้ดูแล = ผู้สร้าง, สาขา = สาขาของผู้สร้าง, เครดิต 30 วัน, วงเงินเริ่มต้นตาม NEW_CUSTOMER_CREDIT)
  .post('/customers', async ({ body, session, ip, branchId }) => {
    const name = body.name.trim()
    if ((await sql`SELECT 1 FROM master.parties WHERE lower(name) = lower(${name})`).length) throw new HttpError(409, 'มีลูกค้า/คู่ค้าชื่อนี้อยู่แล้ว')
    if (!(await sql`SELECT 1 FROM master.price_lists WHERE id = ${body.price_list_id}`).length) throw new HttpError(422, 'ไม่พบกลุ่มราคา')
    const [term] = body.payment_terms_id
      ? await sql`SELECT id FROM master.payment_terms WHERE id = ${body.payment_terms_id}`
      : await sql`SELECT id FROM master.payment_terms WHERE credit_days = 30 ORDER BY code LIMIT 1`
    if (body.payment_terms_id && !term) throw new HttpError(422, 'ไม่พบเงื่อนไขชำระเงิน')
    const id = crypto.randomUUID()
    const code = await withRetry(async () => {
      const code = await nextPartyCode()
      await sql.transaction([
        sql`INSERT INTO master.parties (id, code, name, tax_id) VALUES (${id}, ${code}, ${name}, ${body.tax_id?.trim() || null})`,
        sql`INSERT INTO master.party_roles (party_id, role) VALUES (${id}, 'customer')`,
        sql`INSERT INTO master.customers (party_id, price_list_id, payment_terms_id, credit_limit, owner_user_id, branch_id, status)
            VALUES (${id}, ${body.price_list_id}, ${term?.id ?? null}, ${NEW_CUSTOMER_CREDIT}, ${session.userId}, ${branchId}, 'active')`,
        audit({ session, ip }, { action: 'create_customer', table: 'master.customers', id, ref: name, after: { code, name, price_list_id: body.price_list_id, credit_limit: NEW_CUSTOMER_CREDIT } }),
      ])
      return code
    })
    return { id, code }
  }, { body: t.Object({ name: t.String({ minLength: 1, maxLength: 150 }), tax_id: t.Optional(t.String({ maxLength: 20 })), price_list_id: UUID, payment_terms_id: t.Optional(UUID) }) })

  // ขอยกเว้นการบล็อกเครดิต → คำขอ CREDIT_EXCEPTION เข้าสายอนุมัติตาม Workflow ที่ Admin ตั้งไว้
  .post('/customers/:id/credit-exception', async ({ params, body, session, ip, branchId, teamIds }) => {
    const [c] = await sql`
      SELECT c.party_id, p.name, c.credit_limit::float8 AS credit_limit, c.status,
             COALESCE((SELECT sum(i.total - i.paid_amount) FROM accounting.invoices i WHERE i.direction = 'AR' AND i.party_id = c.party_id AND i.status IN ('issued','verified','partially_paid')), 0)::float8
           + COALESCE((SELECT sum(o.total) FROM sales.sales_orders o WHERE o.customer_id = c.party_id AND o.status IN ('approved','ready_to_ship','partially_shipped','shipped')), 0)::float8 AS used,
             EXISTS (SELECT 1 FROM accounting.invoices i WHERE i.direction = 'AR' AND i.party_id = c.party_id AND i.status IN ('issued','verified','partially_paid')
                        AND i.total > i.paid_amount AND i.due_date < current_date - ${RULES.hold_overdue_days}::int) AS overdue_hold
        FROM master.customers c JOIN master.parties p ON p.id = c.party_id
       WHERE c.party_id = ${params.id} AND (c.owner_user_id = ANY(${teamIds}::uuid[]) OR c.branch_id = ${branchId}::uuid)`
    if (!c) throw new HttpError(404, 'ไม่พบลูกค้าในความดูแล')
    if (!(c.status === 'credit_hold' || c.overdue_hold || (c.credit_limit > 0 && c.used >= c.credit_limit))) throw new HttpError(409, 'ลูกค้ารายนี้ไม่ได้ถูกบล็อก ไม่ต้องขอยกเว้น')
    if ((await sql`SELECT 1 FROM platform.requests WHERE type = 'CREDIT_EXCEPTION' AND ref_table = 'master.customers' AND ref_id = ${c.party_id} AND requester_id = ANY(${teamIds}::uuid[]) AND status = 'pending'`).length)
      throw new HttpError(409, 'มีคำขอยกเว้นของลูกค้ารายนี้รออนุมัติอยู่แล้ว')
    const roleIds = await planSteps(['CREDIT_EXCEPTION'], c.used)
    if (!roleIds.length) throw new HttpError(422, 'ยังไม่มีนโยบายอนุมัติ "ขอยกเว้นเครดิตลูกค้า" — แจ้ง Admin ตั้งค่า Workflow อนุมัติ')
    const reason = body.reason.trim()
    const req = await withRetry(async () => {
      const r = await prepareRequest({ session, ip }, {
        type: 'CREDIT_EXCEPTION', amount: c.used, refTable: 'master.customers', refId: c.party_id, roleIds, branchId,
        payload: { summary: `${c.name} · ${WHY[body.why]}`, customer: c.name, why: body.why, reason },
      })
      await sql.transaction([
        ...r.queries,
        audit({ session, ip }, { action: 'request_credit_exception', table: 'platform.requests', id: r.id, ref: r.request_no, after: { customer: c.name, why: body.why, reason }, risk: 'medium' }),
      ])
      return r
    })
    return { id: req.id, request_no: req.request_no }
  }, { params: t.Object({ id: UUID }), body: t.Object({ why: t.Union([t.Literal('overdue'), t.Literal('limit')]), reason: t.String({ minLength: 1, maxLength: 300 }) }) })
