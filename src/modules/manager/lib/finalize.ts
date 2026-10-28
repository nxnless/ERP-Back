import { sql } from '../../../shared/db'

/**
 * ผลข้างเคียงต่อ "เอกสารต้นทาง" (ref_table) เมื่อคำขอปิดจบ — แก้ตารางนี้ได้ถ้าโมดูลอื่นกำหนดสถานะต่างจากนี้
 * คืนคำสั่ง (ยังไม่รัน) เพื่อใส่ใน transaction เดียวกับการอนุมัติ
 * ทุกคำสั่งมีเงื่อนไขสถานะเดิม จึงรันซ้ำแล้วไม่ทำอะไรเพิ่ม
 */
type Ref = { id: string; ref_table: string | null; ref_id: string | null }

/** เรียกต่อจาก UPDATE platform.requests — ทำงานเฉพาะเมื่อคำขอถูกปิดเป็น approved แล้วเท่านั้น */
export function onApproved(p: Ref) {
  const id = p.ref_id
  if (!p.ref_table || !id) return []
  switch (p.ref_table) {
    case 'sales.sales_orders':
      return [sql`UPDATE sales.sales_orders SET status = 'approved', updated_at = now() WHERE id = ${id} AND status = 'pending_approval'
                    AND EXISTS (SELECT 1 FROM platform.requests WHERE id = ${p.id} AND status = 'approved')`]
    case 'purchasing.purchase_orders':
      return [sql`UPDATE purchasing.purchase_orders SET status = 'approved', updated_at = now() WHERE id = ${id} AND status = 'pending_approval'
                    AND EXISTS (SELECT 1 FROM platform.requests WHERE id = ${p.id} AND status = 'approved')`]
    case 'purchasing.purchase_requisitions':
      return [sql`UPDATE purchasing.purchase_requisitions SET status = 'approved', updated_at = now() WHERE id = ${id} AND status = 'pending_approval'
                    AND EXISTS (SELECT 1 FROM platform.requests WHERE id = ${p.id} AND status = 'approved')`]
    case 'hr.leave_requests':
      return [
        // ตัดสิทธิ์ลา: สมมติว่า leave_ledger เก็บ "used" เป็นค่าลบ (ยอดคงเหลือ = sum(days)) — ตรวจให้ตรงกับโมดูลพนักงาน
        sql`INSERT INTO hr.leave_ledger (employee_id, leave_type_code, year, days, reason, ref_table, ref_id)
            SELECT lr.employee_id, lr.leave_type_code, extract(year FROM lr.start_date)::int, -lr.days, 'used', 'hr.leave_requests', lr.id
              FROM hr.leave_requests lr WHERE lr.id = ${id} AND lr.status = 'pending'
               AND EXISTS (SELECT 1 FROM platform.requests WHERE id = ${p.id} AND status = 'approved')`,
        sql`UPDATE hr.leave_requests SET status = 'approved' WHERE id = ${id} AND status = 'pending'
              AND EXISTS (SELECT 1 FROM platform.requests WHERE id = ${p.id} AND status = 'approved')`,
      ]
    case 'hr.ot_requests':
      return [sql`UPDATE hr.ot_requests SET status = 'approved' WHERE id = ${id} AND status = 'pending'
                    AND EXISTS (SELECT 1 FROM platform.requests WHERE id = ${p.id} AND status = 'approved')`]
    case 'hr.payroll_runs':
      return [sql`UPDATE hr.payroll_runs SET status = 'approved', updated_at = now() WHERE id = ${id} AND status = 'accounting_checked'
                    AND EXISTS (SELECT 1 FROM platform.requests WHERE id = ${p.id} AND status = 'approved')`]
    default:
      return [] // เช่น QUOTATION*, EXPENSE, PAYMENT — โมดูลเจ้าของเอกสารอ่านผลจาก platform.requests เอง
  }
}

/** เรียกต่อจากการปิดคำขอเป็น rejected (ผู้จัดการไม่อนุมัติ) */
export function onRejected(p: Ref) {
  const id = p.ref_id
  if (!p.ref_table || !id) return []
  switch (p.ref_table) {
    case 'sales.sales_orders':
      return [sql`UPDATE sales.sales_orders SET status = 'cancelled', updated_at = now() WHERE id = ${id} AND status = 'pending_approval'`]
    case 'purchasing.purchase_orders': // กลับเป็นร่างให้ผู้ซื้อแก้แล้วยื่นใหม่
      return [sql`UPDATE purchasing.purchase_orders SET status = 'draft', updated_at = now() WHERE id = ${id} AND status = 'pending_approval'`]
    case 'purchasing.purchase_requisitions':
      return [sql`UPDATE purchasing.purchase_requisitions SET status = 'rejected', updated_at = now() WHERE id = ${id} AND status = 'pending_approval'`]
    case 'hr.leave_requests':
      return [sql`UPDATE hr.leave_requests SET status = 'rejected' WHERE id = ${id} AND status = 'pending'`]
    case 'hr.ot_requests':
      return [sql`UPDATE hr.ot_requests SET status = 'rejected' WHERE id = ${id} AND status = 'pending'`]
    case 'hr.payroll_runs': // ส่งกลับ HR แก้ไข
      return [sql`UPDATE hr.payroll_runs SET status = 'draft', updated_at = now() WHERE id = ${id} AND status = 'accounting_checked'`]
    default:
      return []
  }
}
