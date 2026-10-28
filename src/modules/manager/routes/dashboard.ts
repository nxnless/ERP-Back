import { Elysia } from 'elysia'
import { sql } from '../../../shared/db'
import { managerOnly } from '../guard'
import { bkkToday, monthStart, prevWindowEnd } from '../lib/util'

/** ยอดขายนับใบสั่งขายที่ผ่านการอนุมัติแล้ว ก่อน VAT (subtotal) */
export const dashboardRoutes = new Elysia()
  .use(managerOnly)
  .get('/dashboard', async ({ branchId: b }) => {
    const T = bkkToday(), cs = monthStart(T), ps = monthStart(T, 1), pe = prevWindowEnd(T), s5 = monthStart(T, 5)
    const [[sales], [target], months, [backlog], [ar], [ap], lowStock, late] = await Promise.all([
      sql`SELECT COALESCE(sum(subtotal) FILTER (WHERE order_date >= ${cs}::date), 0)::float8 AS mtd,
                 COALESCE(sum(subtotal) FILTER (WHERE order_date >= ${ps}::date AND order_date < ${pe}::date), 0)::float8 AS prev
            FROM sales.sales_orders
           WHERE branch_id = ${b} AND status NOT IN ('pending_approval','cancelled') AND order_date >= ${ps}::date AND order_date <= ${T}::date`,
      sql`SELECT amount::float8 AS amount FROM sales.sales_targets WHERE branch_id = ${b} AND department_id IS NULL AND period = ${cs}::date`,
      sql`SELECT to_char(g.m, 'YYYY-MM') AS ym, COALESCE(sum(so.subtotal), 0)::float8 AS sales,
                 (SELECT t.amount::float8 FROM sales.sales_targets t WHERE t.branch_id = ${b} AND t.department_id IS NULL AND t.period = g.m) AS target
            FROM (SELECT x::date AS m FROM generate_series(${s5}::timestamp, ${cs}::timestamp, interval '1 month') x) g
            LEFT JOIN sales.sales_orders so ON so.branch_id = ${b} AND so.status NOT IN ('pending_approval','cancelled')
                   AND so.order_date >= g.m AND so.order_date < (g.m + interval '1 month')::date
           GROUP BY g.m ORDER BY g.m`,
      sql`SELECT count(*)::int AS n, COALESCE(sum(total), 0)::float8 AS total,
                 count(*) FILTER (WHERE requested_delivery_date < ${T}::date)::int AS late
            FROM sales.sales_orders WHERE branch_id = ${b} AND status IN ('approved','ready_to_ship','partially_shipped')`,
      sql`SELECT COALESCE(sum(total - paid_amount), 0)::float8 AS total, count(DISTINCT party_id)::int AS parties,
                 COALESCE(${T}::date - min(due_date), 0)::int AS oldest
            FROM accounting.invoices
           WHERE direction = 'AR' AND branch_id = ${b} AND status IN ('issued','verified','partially_paid') AND due_date < ${T}::date`,
      sql`SELECT COALESCE(sum(total - paid_amount), 0)::float8 AS total, count(*)::int AS n
            FROM accounting.invoices
           WHERE direction = 'AP' AND branch_id = ${b} AND status IN ('issued','verified','partially_paid')
             AND due_date >= ${T}::date AND due_date <= ${T}::date + 7`,
      sql`SELECT i.sku, i.name, i.uom, s.on_hand::float8 AS on_hand, i.reorder_point::float8 AS reorder_point
            FROM master.items i
            JOIN (SELECT bl.item_id, sum(bl.on_hand) AS on_hand FROM inventory.stock_balances bl
                    JOIN master.warehouses w ON w.id = bl.warehouse_id WHERE w.branch_id = ${b} GROUP BY bl.item_id) s ON s.item_id = i.id
           WHERE i.active AND i.reorder_point > 0 AND s.on_hand <= i.reorder_point
           ORDER BY s.on_hand / i.reorder_point LIMIT 8`,
      sql`SELECT doc_no, party_name_snap AS customer, requested_delivery_date::text AS due, total::float8 AS total, status
            FROM sales.sales_orders
           WHERE branch_id = ${b} AND status IN ('approved','ready_to_ship','partially_shipped') AND requested_delivery_date < ${T}::date
           ORDER BY requested_delivery_date LIMIT 10`,
    ])
    return {
      as_of: T,
      sales: { mtd: sales.mtd, prev: sales.prev, target: target?.amount ?? null },
      backlog, ar_overdue: ar, ap_due7: ap, months, low_stock: lowStock, late_orders: late,
    }
  })
