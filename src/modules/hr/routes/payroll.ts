import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { hrOnly, moduleAccess } from '../guard'
import { audit } from '../lib/audit'
import { exceptionQueries, refreshTotals, runTotals, seedItemQueries } from '../lib/payroll'
import { prepareRequest } from '../lib/requests'
import { ADJUSTMENTS, MONTH, UUID, adjustmentKind, assertAdjustment, runNo } from '../lib/rules'

/**
 * HR เตรียมรอบเงินเดือน: สร้างรอบ (ระบบคำนวณรายการรายคน) → เพิ่มโบนัส/รายการหัก (ต้องมีเหตุผล) → ส่งให้บัญชีตรวจ
 * หลังส่ง ยอดและรายการล็อก — การตรวจ/อนุมัติ/จ่าย เป็นของบัญชีและผู้จัดการ (ผ่านคำขอ PAYROLL) จึงไม่มี endpoint อนุมัติหรือจ่ายที่นี่
 * สถานะ = hr.payroll_runs.status (draft → submitted_to_accounting → accounting_checked → approved → paid | cancelled)
 * เพิ่มค่า 'rejected' ในผลลัพธ์เมื่อคำขอ PAYROLL ของรอบนี้ถูกส่งกลับ (HR เปิดกลับเป็นฉบับร่างได้)
 */

async function loadRun(id: string) {
  const [r] = await sql`
    SELECT pr.id, pr.run_no, to_char(pr.period, 'YYYY-MM') AS month, pr.pay_date, pr.headcount, pr.total_earnings::float8 AS total_earnings,
           pr.total_deductions::float8 AS total_deductions, pr.net_pay::float8 AS net_pay, rq.request_no,
           CASE WHEN pr.status IN ('submitted_to_accounting','accounting_checked') AND rq.status = 'rejected' THEN 'rejected' ELSE pr.status END AS status
      FROM hr.payroll_runs pr LEFT JOIN platform.requests rq ON rq.id = pr.approval_request_id WHERE pr.id = ${id}`
  if (!r) throw new HttpError(404, 'ไม่พบรอบเงินเดือน')
  return r as { id: string; run_no: string; month: string; pay_date: string; headcount: number; total_earnings: number; total_deductions: number; net_pay: number; request_no: string | null; status: string }
}
async function loadDraft(id: string) {
  const r = await loadRun(id)
  if (r.status !== 'draft') throw new HttpError(409, 'รอบนี้ส่งให้บัญชีตรวจแล้ว แก้ไขไม่ได้')
  return r
}

export const payrollRoutes = new Elysia()
  .use(hrOnly)
  .get('/payroll/runs', async () => {
    const rows = await sql`
      SELECT pr.id, pr.run_no, to_char(pr.period, 'YYYY-MM') AS month, pr.headcount, pr.total_earnings::float8 AS total_earnings,
             pr.total_deductions::float8 AS total_deductions, pr.net_pay::float8 AS net, rq.request_no,
             CASE WHEN pr.status IN ('submitted_to_accounting','accounting_checked') AND rq.status = 'rejected' THEN 'rejected' ELSE pr.status END AS status
        FROM hr.payroll_runs pr LEFT JOIN platform.requests rq ON rq.id = pr.approval_request_id ORDER BY pr.period DESC LIMIT 24`
    return rows
  }, { beforeHandle: moduleAccess('payroll', 'read') })

  .post('/payroll/runs', async ({ body, session, ip }) => {
    const no = runNo(body.month), id = crypto.randomUUID(), period = body.month + '-01'
    if ((await sql`SELECT 1 FROM hr.payroll_runs WHERE period = ${period}::date`).length) throw new HttpError(409, 'มีรอบเงินเดือนของเดือนนี้แล้ว')
    await sql.transaction([
      sql`INSERT INTO hr.payroll_runs (id, run_no, period, pay_date, created_by)
          VALUES (${id}, ${no}, ${period}::date, (${period}::date + interval '1 month' - interval '1 day')::date, ${session.userId})`,
      ...seedItemQueries(id, session.userId), // รายการระบบ + รีเฟรชยอดรวม
      audit({ session, ip }, { action: 'create_payroll_run', module: 'payroll', table: 'hr.payroll_runs', id, ref: no, after: { month: body.month } }),
    ])
    return { id, run_no: no }
  }, { beforeHandle: moduleAccess('payroll', 'write'), body: t.Object({ month: MONTH }) })

  .get('/payroll/runs/:id', async ({ params }) => {
    const run = await loadRun(params.id)
    const [adjustments, employees, review] = await Promise.all([
      sql`SELECT i.id, i.employee_id, e.full_name, i.kind, i.component, i.amount::float8 AS amount, i.reason
            FROM hr.payroll_items i JOIN hr.employees e ON e.id = i.employee_id WHERE i.run_id = ${params.id} AND i.source = 'adjustment' ORDER BY i.created_at DESC`,
      sql`SELECT DISTINCT e.id, e.code AS employee_no, e.full_name FROM hr.payroll_items i JOIN hr.employees e ON e.id = i.employee_id
           WHERE i.run_id = ${params.id} ORDER BY e.code`,
      // ความคืบหน้าการอนุมัติของคำขอ PAYROLL: ใครตรวจ/อนุมัติแล้ว ใครส่งกลับ พร้อมหมายเหตุ (HR ใช้ติดตามและแก้ไขตามที่บัญชีส่งกลับ)
      sql`SELECT s.seq, ro.name AS role_name, s.status, s.comment, s.acted_at, u.display_name AS actor
            FROM hr.payroll_runs pr JOIN platform.request_steps s ON s.request_id = pr.approval_request_id
            JOIN platform.roles ro ON ro.id = s.approver_role_id LEFT JOIN platform.users u ON u.id = s.approver_user_id
           WHERE pr.id = ${params.id} ORDER BY s.seq`,
    ])
    return { run, totals: await runTotals(run), adjustments, employees, review, labels: ADJUSTMENTS }
  }, { beforeHandle: moduleAccess('payroll', 'read'), params: t.Object({ id: UUID }) })

  .post('/payroll/runs/:id/adjustments', async ({ params, body, session, ip }) => {
    const run = await loadDraft(params.id)
    assertAdjustment(body)
    const kind = adjustmentKind(body.component)!
    if (!(await sql`SELECT 1 FROM hr.payroll_items WHERE run_id = ${params.id} AND employee_id = ${body.employee_id} LIMIT 1`).length) throw new HttpError(422, 'พนักงานคนนี้ไม่อยู่ในรอบเงินเดือนนี้')
    const id = crypto.randomUUID(), reason = body.reason.trim()
    await sql.transaction([
      sql`INSERT INTO hr.payroll_items (id, run_id, employee_id, kind, component, amount, source, reason, created_by)
          SELECT ${id}::uuid, pr.id, ${body.employee_id}::uuid, ${kind}, ${body.component}, ${body.amount}::numeric, 'adjustment', ${reason}, ${session.userId}::uuid
            FROM hr.payroll_runs pr WHERE pr.id = ${params.id} AND pr.status = 'draft'`,
      ...refreshTotals(params.id),
      audit({ session, ip }, { action: 'add_payroll_adjustment', module: 'payroll', table: 'hr.payroll_items', id, ref: run.run_no,
        after: { employee_id: body.employee_id, component: body.component, amount: body.amount, reason } }),
    ])
    return { id }
  }, {
    beforeHandle: moduleAccess('payroll', 'write'), params: t.Object({ id: UUID }),
    body: t.Object({ employee_id: UUID, component: t.String({ minLength: 1 }), amount: t.Number({ exclusiveMinimum: 0 }), reason: t.String({ minLength: 1, maxLength: 300 }) }),
  })

  .delete('/payroll/runs/:id/adjustments/:adjId', async ({ params, session, ip }) => {
    const run = await loadDraft(params.id)
    const [a] = await sql`SELECT kind, component, amount::float8 AS amount, employee_id FROM hr.payroll_items WHERE id = ${params.adjId} AND run_id = ${params.id} AND source = 'adjustment'`
    if (!a) throw new HttpError(404, 'ไม่พบรายการ')
    await sql.transaction([
      sql`DELETE FROM hr.payroll_items WHERE id = ${params.adjId} AND run_id = ${params.id} AND source = 'adjustment'`,
      ...refreshTotals(params.id),
      audit({ session, ip }, { action: 'delete_payroll_adjustment', module: 'payroll', table: 'hr.payroll_items', id: params.adjId, ref: run.run_no, before: a }),
    ])
    return { ok: true }
  }, { beforeHandle: moduleAccess('payroll', 'write'), params: t.Object({ id: UUID, adjId: UUID }) })

  // ส่งให้บัญชีตรวจ: สร้างคำขอ PAYROLL ตามนโยบาย Workflow (วงเงิน = ยอดจ่ายสุทธิ) แล้วเปลี่ยนสถานะรอบ — หลังจากนี้แก้ไม่ได้
  .post('/payroll/runs/:id/submit', async ({ params, session, ip }) => {
    const run = await loadDraft(params.id)
    if (run.headcount === 0) throw new HttpError(422, 'ไม่มีพนักงานในรอบนี้')
    const req = await prepareRequest({
      type: 'PAYROLL', requesterId: session.userId, amount: run.net_pay, ref: { table: 'hr.payroll_runs', id: run.id },
      payload: { summary: `รอบเงินเดือน ${run.month} · ${run.headcount} คน`, run_id: run.id, run_no: run.run_no, period: run.month, headcount: run.headcount,
        total_earnings: run.total_earnings, total_deductions: run.total_deductions, net_pay: run.net_pay },
    })
    await sql.transaction([
      ...req.queries,
      sql`UPDATE hr.payroll_runs SET status = 'submitted_to_accounting', approval_request_id = ${req.id}, updated_at = now() WHERE id = ${params.id} AND status = 'draft'`,
      ...exceptionQueries(params.id), // รายการผิดปกติให้บัญชียืนยัน
      audit({ session, ip }, { action: 'submit_payroll_run', module: 'payroll', table: 'hr.payroll_runs', id: params.id, ref: run.run_no,
        after: { request: req.request_no, headcount: run.headcount, net_pay: run.net_pay }, risk: 'medium' }),
    ])
    return { request_no: req.request_no }
  }, { beforeHandle: moduleAccess('payroll', 'write'), params: t.Object({ id: UUID }) })

  // รอบที่ถูกส่งกลับ → เปิดกลับเป็นฉบับร่างเพื่อแก้แล้วส่งใหม่
  .post('/payroll/runs/:id/reopen', async ({ params, session, ip }) => {
    const run = await loadRun(params.id)
    if (run.status !== 'rejected') throw new HttpError(409, 'เปิดแก้ได้เฉพาะรอบที่ถูกส่งกลับ')
    await sql.transaction([
      sql`UPDATE hr.payroll_runs SET status = 'draft', approval_request_id = NULL, updated_at = now()
           WHERE id = ${params.id} AND status IN ('submitted_to_accounting','accounting_checked')`,
      sql`DELETE FROM hr.payroll_exceptions WHERE run_id = ${params.id}`,
      audit({ session, ip }, { action: 'reopen_payroll_run', module: 'payroll', table: 'hr.payroll_runs', id: params.id, ref: run.run_no, before: { request: run.request_no }, risk: 'medium' }),
    ])
    return { ok: true }
  }, { beforeHandle: moduleAccess('payroll', 'write'), params: t.Object({ id: UUID }) })
