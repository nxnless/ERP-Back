import { sql } from '../../../shared/db'
import { SSO } from './rules'

/**
 * รอบเงินเดือนเก็บเป็นรายการรายคนใน hr.payroll_items (source = 'system' คำนวณตอนสร้างรอบ, 'adjustment' ที่ HR เพิ่ม)
 * ยอดรวมของรอบ (headcount, total_earnings, total_deductions) เป็นแคชบน hr.payroll_runs — ต้องรีเฟรชทุกครั้งที่รายการเปลี่ยน
 */
export type Totals = { headcount: number; gross: number; deductions: number; net: number; earn: number; deduct: number }

/** รายการที่ระบบคำนวณให้ทุกคนในรอบ: เงินเดือน เบี้ย OT (จากใบ OT ที่อนุมัติ) ประกันสังคม กองทุนสำรองเลี้ยงชีพ
 *  ภาษี (TAX) ไม่ถูกคำนวณที่นี่ — เพิ่มเมื่อมีสูตรภาษี (รายการ TAX เป็น source = 'system' เช่นกัน) */
export function seedItemQueries(runId: string, createdBy: string) {
  const comp = sql`
    WITH run AS (SELECT period, (period + interval '1 month' - interval '1 day')::date AS period_end FROM hr.payroll_runs WHERE id = ${runId}),
    emp AS (
      SELECT e.id AS employee_id, c.base_salary, c.allowance, c.ot_rate_per_hour, c.provident_fund_pct
        FROM run, hr.employees e
        JOIN LATERAL (SELECT * FROM hr.compensation x WHERE x.employee_id = e.id AND x.effective_from <= run.period_end ORDER BY x.effective_from DESC LIMIT 1) c ON true
       WHERE e.hire_date <= run.period_end AND (e.termination_date IS NULL OR e.termination_date >= run.period)
    ),
    ot AS (
      SELECT o.employee_id, sum(o.hours) AS hours FROM hr.ot_requests o, run
       WHERE o.status = 'approved' AND o.work_date >= run.period AND o.work_date <= run.period_end GROUP BY o.employee_id
    )
    INSERT INTO hr.payroll_items (run_id, employee_id, kind, component, amount, source, created_by)
    SELECT ${runId}::uuid, v.employee_id, v.kind, v.component, round(v.amount, 2), 'system', ${createdBy}::uuid
      FROM (
        SELECT employee_id, 'earning' AS kind, 'BASE' AS component, base_salary AS amount FROM emp
        UNION ALL SELECT employee_id, 'earning', 'ALLOWANCE', allowance FROM emp
        UNION ALL SELECT emp.employee_id, 'earning', 'OT', ot.hours * emp.ot_rate_per_hour FROM emp JOIN ot USING (employee_id)
        UNION ALL SELECT employee_id, 'deduction', 'SSO', least(base_salary * ${SSO.rate}::numeric, ${SSO.cap}::numeric) FROM emp
        UNION ALL SELECT employee_id, 'deduction', 'PROVIDENT', base_salary * provident_fund_pct / 100 FROM emp
      ) v
     WHERE v.amount > 0`
  return [comp, ...refreshTotals(runId)]
}

/** คำสั่งรีเฟรชแคชยอดรวมของรอบ (ใช้ได้เฉพาะรอบที่ยังเป็น draft) — ใส่ท้าย sql.transaction([...]) ที่แก้รายการ */
export function refreshTotals(runId: string) {
  return [sql`
    UPDATE hr.payroll_runs r SET updated_at = now(),
           headcount = (SELECT count(DISTINCT employee_id) FROM hr.payroll_items WHERE run_id = r.id),
           total_earnings = (SELECT COALESCE(sum(amount), 0) FROM hr.payroll_items WHERE run_id = r.id AND kind = 'earning'),
           total_deductions = (SELECT COALESCE(sum(amount), 0) FROM hr.payroll_items WHERE run_id = r.id AND kind = 'deduction')
     WHERE r.id = ${runId} AND r.status = 'draft'`]
}

/** ยอดของรอบ: แคชบน payroll_runs + แยกส่วนที่ HR ปรับ (source = 'adjustment') */
export async function runTotals(run: { id: string; headcount: number; total_earnings: number; total_deductions: number }): Promise<Totals> {
  const [a] = await sql`
    SELECT COALESCE(sum(amount) FILTER (WHERE kind = 'earning'), 0)::float8 AS earn, COALESCE(sum(amount) FILTER (WHERE kind = 'deduction'), 0)::float8 AS deduct
      FROM hr.payroll_items WHERE run_id = ${run.id} AND source = 'adjustment'`
  const gross = Number(run.total_earnings), deductions = Number(run.total_deductions)
  return { headcount: run.headcount, gross, deductions, net: gross - deductions, earn: a.earn, deduct: a.deduct }
}

/** เกณฑ์ชั่วโมง OT ต่อเดือนที่ต้องให้บัญชียืนยัน */
export const OT_REVIEW_HOURS = 40

/**
 * รายการผิดปกติที่บัญชีต้องยืนยันก่อนผ่านการตรวจ (hr.payroll_exceptions) — สร้างตอน HR ส่งรอบ:
 * OT เกินเกณฑ์, พนักงานใหม่ในเดือน, ลาออกในเดือน, ปรับเงินเดือน/เบี้ยที่มีผลในเดือน (เฉพาะคนที่อยู่ในรอบ)
 * ล้างของเดิมก่อนทุกครั้ง (ส่งใหม่หลังถูกส่งกลับจะได้รายการสดและยังไม่ยืนยัน)
 */
export function exceptionQueries(runId: string) {
  return [
    sql`DELETE FROM hr.payroll_exceptions WHERE run_id = ${runId}`,
    sql`
      WITH run AS (SELECT id, period, (period + interval '1 month' - interval '1 day')::date AS pe FROM hr.payroll_runs WHERE id = ${runId})
      INSERT INTO hr.payroll_exceptions (run_id, employee_id, description)
      SELECT run.id, x.employee_id, x.description FROM run, LATERAL (
        SELECT o.employee_id, 'OT ' || trim(to_char(sum(o.hours), 'FM999990.0')) || ' ชม. สูงกว่าเกณฑ์ ' || ${OT_REVIEW_HOURS}::text || ' ชม.' AS description
          FROM hr.ot_requests o WHERE o.status = 'approved' AND o.work_date BETWEEN run.period AND run.pe GROUP BY o.employee_id HAVING sum(o.hours) > ${OT_REVIEW_HOURS}::numeric
        UNION ALL SELECT e.id, 'พนักงานใหม่ เริ่ม ' || to_char(e.hire_date, 'DD/MM/YYYY') || ' · ตรวจสอบการคำนวณเงินเดือนบางส่วนของเดือน'
          FROM hr.employees e WHERE e.hire_date BETWEEN run.period AND run.pe
        UNION ALL SELECT e.id, 'ลาออก ' || to_char(e.termination_date, 'DD/MM/YYYY') || ' · ตรวจค่าชดเชยและวันลาสะสม'
          FROM hr.employees e WHERE e.termination_date BETWEEN run.period AND run.pe
        UNION ALL SELECT c.employee_id, 'ปรับเงินเดือน/เบี้ย มีผล ' || to_char(c.effective_from, 'DD/MM/YYYY')
          FROM hr.compensation c JOIN hr.employees e ON e.id = c.employee_id WHERE c.effective_from BETWEEN run.period AND run.pe AND c.effective_from > e.hire_date
      ) x
      WHERE EXISTS (SELECT 1 FROM hr.payroll_items i WHERE i.run_id = run.id AND i.employee_id = x.employee_id)`,
  ]
}
