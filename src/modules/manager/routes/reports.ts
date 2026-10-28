import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { managerOnly } from '../guard'
import { bkkToday, monthStart, prevWindowEnd } from '../lib/util'

type Out = { id: string | null; name: string; mine: boolean; sales: number; prev: number; target: number | null; orders: number; close_rate: number | null; change: number | null }

/**
 * เปรียบเทียบผลงานเดือนนี้ (ถึงวันนี้) กับเป้าและ "ช่วงเดียวกันของเดือนก่อน"
 *  by='department' → ทีม = แผนกของพนักงานขาย (hr.employees.department_id) เฉพาะสาขาตนเอง
 *  by='branch'     → ทุกสาขา แต่เป็นยอดรวมเท่านั้น (ไม่เห็นรายการของสาขาอื่น)
 * อัตราปิดการขาย = ใบเสนอราคาที่ลูกค้าตอบรับ/แปลงเป็นใบสั่งขาย ÷ ใบเสนอราคาที่ส่งแล้ว (ออกในเดือนนี้)
 */
async function perf(by: 'department' | 'branch', mine: string): Promise<Out[]> {
  const T = bkkToday(), cs = monthStart(T), ps = monthStart(T, 1), pe = prevWindowEnd(T)
  const scope = by === 'department' ? mine : null
  const gs = by === 'department' ? 'e.department_id' : 'so.branch_id'
  const gq = by === 'department' ? 'e.department_id' : 'q.branch_id'
  const [orders, quotes, targets, names] = await Promise.all([
    sql.query(
      `SELECT ${gs} AS gid,
              COALESCE(sum(so.subtotal) FILTER (WHERE so.order_date >= $2::date), 0)::float8 AS sales,
              COALESCE(sum(so.subtotal) FILTER (WHERE so.order_date >= $3::date AND so.order_date < $4::date), 0)::float8 AS prev,
              (count(*) FILTER (WHERE so.order_date >= $2::date))::int AS orders
         FROM sales.sales_orders so LEFT JOIN hr.employees e ON e.user_id = so.salesperson_id
        WHERE so.status NOT IN ('pending_approval','cancelled') AND so.order_date >= $3::date AND so.order_date <= $5::date
          AND ($1::uuid IS NULL OR so.branch_id = $1::uuid)
        GROUP BY 1`, [scope, cs, ps, pe, T]),
    sql.query(
      `SELECT ${gq} AS gid,
              (count(*) FILTER (WHERE q.status IN ('accepted','converted')))::int AS won,
              (count(*) FILTER (WHERE q.status NOT IN ('draft','pending_discount_approval','pending_exec_approval')))::int AS sent
         FROM sales.quotations q LEFT JOIN hr.employees e ON e.user_id = q.salesperson_id
        WHERE q.quote_date >= $2::date AND ($1::uuid IS NULL OR q.branch_id = $1::uuid)
        GROUP BY 1`, [scope, cs]),
    sql.query(
      `SELECT CASE WHEN $3::boolean THEN department_id ELSE branch_id END AS gid, amount::float8 AS amount
         FROM sales.sales_targets
        WHERE period = $2::date AND ($1::uuid IS NULL OR branch_id = $1::uuid) AND (department_id IS NOT NULL) = $3::boolean`, [scope, cs, by === 'department']),
    by === 'department'
      ? sql`SELECT id, name FROM master.departments`
      : sql`SELECT id, name FROM platform.branches WHERE active`,
  ])
  type G = string | null
  const q = new Map<G, any>(quotes.map((x: any) => [x.gid, x]))
  const tg = new Map<G, number>(targets.map((x: any) => [x.gid, x.amount]))
  const o = new Map<G, any>(orders.map((x: any) => [x.gid, x]))
  const nm = new Map<string, string>(names.map((x: any) => [x.id, x.name]))
  // สาขา: แสดงทุกสาขาที่ใช้งาน · ทีม: แสดงแผนกที่มียอดหรือมีเป้า (และกลุ่ม "ไม่ระบุ" ถ้ามียอดที่หาแผนกไม่ได้)
  const keys: G[] = by === 'branch' ? [...nm.keys()] : [...new Set<G>([...o.keys(), ...tg.keys()])]
  return keys.map((k) => {
    const a = o.get(k), c = q.get(k)
    const sales = a?.sales ?? 0, prev = a?.prev ?? 0
    return {
      id: k, name: k ? nm.get(k) ?? '—' : 'ไม่ระบุแผนก', mine: by === 'branch' && k === mine,
      sales, prev, target: tg.get(k) ?? null, orders: a?.orders ?? 0,
      close_rate: c?.sent ? Math.round((c.won / c.sent) * 100) : null,
      change: prev > 0 ? Math.round(((sales - prev) / prev) * 1000) / 10 : null,
    }
  }).sort((x, y) => y.sales - x.sales)
}

export const reportRoutes = new Elysia()
  .use(managerOnly)
  .get('/reports', async ({ query, branchId }) => ({
    view: query.view ?? 'team', as_of: bkkToday(), rows: await perf(query.view === 'branch' ? 'branch' : 'department', branchId),
  }), { query: t.Object({ view: t.Optional(t.Union([t.Literal('team'), t.Literal('branch')])) }) })
