import { Elysia, t } from 'elysia'
import { auth, sql, HttpError } from '../deps'

/** เห็นสลิปเฉพาะของตนเอง และเฉพาะรอบที่ผู้จัดการอนุมัติแล้ว (approved/paid) */
export const payslipRoutes = new Elysia()
  .use(auth)
  .get('/payslips', async ({ emp }) => {
    const rows = await sql`
    SELECT ps.id, to_char(pr.period, 'YYYY-MM') AS period, pr.pay_date::text AS pay_date,
           ps.gross::float8 AS gross, ps.deductions::float8 AS deductions, ps.net::float8 AS net
      FROM hr.payslips ps JOIN hr.payroll_runs pr ON pr.id = ps.run_id
     WHERE ps.employee_id = ${emp.id} AND pr.status IN ('approved','paid') ORDER BY pr.period DESC LIMIT 24`
    return rows
  })
  .get('/payslips/:id', async ({ emp, params }) => {
    const [row] = await sql`
      SELECT ps.id, to_char(pr.period, 'YYYY-MM') AS period, pr.pay_date::text AS pay_date, ps.gross::float8 AS gross,
             ps.deductions::float8 AS deductions, ps.net::float8 AS net, ps.detail,
             (SELECT bank_name || ' ' || account_last4 FROM hr.employee_bank_accounts b WHERE b.employee_id = ps.employee_id AND b.status = 'active' LIMIT 1) AS bank
        FROM hr.payslips ps JOIN hr.payroll_runs pr ON pr.id = ps.run_id
       WHERE ps.id = ${params.id} AND ps.employee_id = ${emp.id} AND pr.status IN ('approved','paid')`
    if (!row) throw new HttpError(404, 'ไม่พบสลิปเงินเดือน')
    return row
  }, { params: t.Object({ id: t.String({ format: 'uuid' }) }) })
