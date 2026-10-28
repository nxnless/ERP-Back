import { sql } from '../../../shared/db'
import { EXCEPTION_VALID_DAYS, HOLD_OVERDUE_DAYS } from './rules'

/**
 * สถานะเครดิตของลูกค้า 1 ราย
 *  used = ยอดค้างรับ (AR ที่ยังไม่ชำระ) + ใบสั่งขายที่อนุมัติแล้วแต่ยังไม่ออกใบแจ้งหนี้
 *  hold = บัญชีสั่งระงับ (credit_hold) หรือมีใบแจ้งหนี้ค้างเกินกำหนดเกิน HOLD_OVERDUE_DAYS วัน
 */
export async function creditOf(customerId: string) {
  const [r] = await sql`
    SELECT c.credit_limit::float8 AS credit_limit,
      COALESCE((SELECT sum(i.total - i.paid_amount) FROM accounting.invoices i
                 WHERE i.direction = 'AR' AND i.party_id = c.party_id AND i.status IN ('issued','verified','partially_paid')), 0)::float8
      + COALESCE((SELECT sum(o.total) FROM sales.sales_orders o
                 WHERE o.customer_id = c.party_id AND o.status IN ('approved','ready_to_ship','partially_shipped','shipped')), 0)::float8 AS used,
      (c.status = 'credit_hold' OR EXISTS (SELECT 1 FROM accounting.invoices i
                 WHERE i.direction = 'AR' AND i.party_id = c.party_id AND i.status IN ('issued','verified','partially_paid')
                   AND i.total > i.paid_amount AND i.due_date < current_date - ${HOLD_OVERDUE_DAYS}::int)) AS hold
      FROM master.customers c WHERE c.party_id = ${customerId}`
  return r as { credit_limit: number; used: number; hold: boolean } | undefined
}

/** มีคำขอยกเว้นเครดิตของลูกค้ารายนี้ที่ตนเอง (หรือทีมที่ตนดำเนินการแทนได้) ยื่นและอนุมัติแล้ว (ยังไม่เกินอายุ) หรือไม่ */
export async function hasValidException(customerId: string, userIds: string[]) {
  const rows = await sql`
    SELECT 1 FROM platform.requests
     WHERE type = 'CREDIT_EXCEPTION' AND status = 'approved' AND ref_table = 'master.customers' AND ref_id = ${customerId}
       AND requester_id = ANY(${userIds}::uuid[]) AND decided_at >= now() - make_interval(days => ${EXCEPTION_VALID_DAYS}::int) LIMIT 1`
  return rows.length > 0
}
