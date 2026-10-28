import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { ACCOUNTING_ROLES, accountingOnly, moduleAccess } from '../guard'
import { audit } from '../lib/audit'
import { glBalance } from '../lib/ledger'
import { approveStep, pendingAccountingStep, rejectStep } from '../lib/requests'
import { ACCRUED_PAYROLL, UUID, monthEnd, r2, today } from '../lib/rules'

/**
 * ตรวจรอบเงินเดือน = ขั้นอนุมัติของบทบาทบัญชีในคำขอ PAYROLL ที่ HR ส่งมา
 * ผ่านการตรวจ → ขั้นถัดไป (ผู้จัดการ) · ส่งกลับ HR → คำขอถูกปฏิเสธพร้อมหมายเหตุ (HR เปิดแก้ไขแล้วส่งใหม่ได้)
 * ที่นี่เห็นเฉพาะยอดรวมและรายการผิดปกติ — ไม่เห็นเงินเดือนรายคน
 */
const myRoles = (s: { roles: string[] }) => s.roles.filter((r) => ACCOUNTING_ROLES.includes(r))

async function loadRun(id: string) {
  const [r] = await sql`
    SELECT id, run_no, to_char(period, 'YYYY-MM') AS month, pay_date, status, headcount, total_earnings::float8 AS earnings, total_deductions::float8 AS deductions,
           net_pay::float8 AS net, approval_request_id
      FROM hr.payroll_runs WHERE id = ${id}`
  if (!r) throw new HttpError(404, 'ไม่พบรอบเงินเดือน')
  return r as { id: string; run_no: string; month: string; pay_date: string; status: string; headcount: number; earnings: number; deductions: number; net: number; approval_request_id: string | null }
}

/** รอบที่คำขอถูกส่งกลับ/ตัดสินแล้ว ไม่ใช่ขั้นของบัญชีอีกต่อไป — บอกเหตุผลชัดเจนแทน 404 */
async function assertInReview(run: { status: string; approval_request_id: string | null }) {
  if (run.status !== 'submitted_to_accounting' || !run.approval_request_id) throw new HttpError(409, 'รอบนี้ไม่ได้อยู่ในขั้นตรวจของบัญชี')
  const [r] = await sql`SELECT status FROM platform.requests WHERE id = ${run.approval_request_id}`
  if (r?.status === 'rejected') throw new HttpError(409, 'รอบนี้ถูกส่งกลับ HR แล้ว — รอ HR แก้ไขและส่งใหม่')
}

export type Check = { key: string; label: string; status: 'pass' | 'fail' | 'warn' | 'manual'; detail?: string }

/** ตรวจอัตโนมัติ — status 'fail' ขัดขวางการผ่านการตรวจ ('warn' และ 'manual' เป็นข้อมูลให้ผู้ตรวจพิจารณา) */
async function runChecks(run: { id: string; net: number; month: string }): Promise<Check[]> {
  const [sso] = await sql`
    SELECT count(*)::int AS bad FROM (
      SELECT COALESCE(sum(amount) FILTER (WHERE component = 'BASE'), 0) AS base, COALESCE(sum(amount) FILTER (WHERE component = 'SSO'), 0) AS sso
        FROM hr.payroll_items WHERE run_id = ${run.id} GROUP BY employee_id) x
     WHERE abs(x.sso - round(least(x.base * 0.05, 750), 2)) > 0.01`
  const [bank] = await sql`
    SELECT count(DISTINCT i.employee_id)::int AS total,
           count(DISTINCT i.employee_id) FILTER (WHERE NOT EXISTS (SELECT 1 FROM hr.employee_bank_accounts b WHERE b.employee_id = i.employee_id AND b.status = 'active'))::int AS missing
      FROM hr.payroll_items i WHERE i.run_id = ${run.id}`
  const [dup] = await sql`
    SELECT count(*)::int AS n FROM (SELECT 1 FROM hr.employee_bank_accounts b WHERE b.status = 'active'
       AND b.employee_id IN (SELECT employee_id FROM hr.payroll_items WHERE run_id = ${run.id}) GROUP BY b.bank_name, b.account_last4 HAVING count(*) > 1) d`
  // ยอดค้างจ่ายนับถึงวันสิ้นเดือนของรอบ (หรือวันนี้ ถ้าเลยมาแล้ว) เพื่อให้รายการที่ลงวันสิ้นเดือนถูกนับด้วย
  const accrued = await glBalance(ACCRUED_PAYROLL, [today(), monthEnd(run.month)].sort().pop()!)
  const fmt = (n: number) => n.toLocaleString('th-TH')
  const checks: Check[] = [
    Math.abs(accrued - run.net) < 0.005
      ? { key: 'accrual', label: `ยอดจ่ายสุทธิตรงกับบัญชีเงินเดือนค้างจ่าย ${fmt(run.net)}`, status: 'pass' }
      : { key: 'accrual', label: 'ยอดจ่ายสุทธิไม่ตรงกับบัญชีเงินเดือนค้างจ่าย', status: 'fail', detail: `ยอดจ่ายสุทธิ ${fmt(run.net)} · บัญชี ${ACCRUED_PAYROLL} ${fmt(accrued)} — ลงบัญชีค่าเงินเดือนค้างจ่ายที่สมุดรายวันก่อน` },
    sso.bad === 0
      ? { key: 'sso', label: 'ประกันสังคมคำนวณตามเพดานครบทุกคน', status: 'pass' }
      : { key: 'sso', label: 'ประกันสังคมไม่ตรงตามเพดาน', status: 'fail', detail: `${sso.bad} คน` },
    { key: 'tax', label: 'ภาษีหัก ณ ที่จ่ายตรงกับตารางภาษี', status: 'manual', detail: 'ระบบยังไม่มีตารางภาษี — ตรวจด้วยตนเองก่อนผ่าน' },
    bank.missing === 0
      ? (dup.n === 0
          ? { key: 'bank', label: `เลขบัญชีรับเงินครบ ไม่ซ้ำ ${bank.total} บัญชี`, status: 'pass' }
          : { key: 'bank', label: `เลขบัญชีครบ ${bank.total} บัญชี แต่มีธนาคารและเลขท้าย 4 ตัวซ้ำกัน ${dup.n} ชุด`, status: 'warn', detail: 'เลขบัญชีเข้ารหัสไว้ เทียบได้เฉพาะธนาคาร + เลขท้าย — ตรวจว่าเป็นคนละบัญชีจริง' })
      : { key: 'bank', label: 'พนักงานบางคนยังไม่มีบัญชีรับเงินที่ยืนยันแล้ว', status: 'fail', detail: `${bank.missing} จาก ${bank.total} คน` },
  ]
  return checks
}

export const payrollReviewRoutes = new Elysia()
  .use(accountingOnly)
  .get('/payroll-review/pending-count', async ({ session }) => {
    const [r] = await sql`
      SELECT count(*)::int AS count FROM hr.payroll_runs pr
       WHERE pr.status = 'submitted_to_accounting' AND EXISTS (SELECT 1 FROM platform.request_steps s JOIN platform.roles ro ON ro.id = s.approver_role_id
                WHERE s.request_id = pr.approval_request_id AND s.status = 'pending' AND ro.code = ANY(${myRoles(session)}::text[]))`
    return r
  }, { beforeHandle: moduleAccess('payroll', 'read') })

  .get('/payroll-review/runs', async ({ session }) => await sql`
    SELECT pr.id, pr.run_no, to_char(pr.period, 'YYYY-MM') AS month, pr.headcount, pr.net_pay::float8 AS net,
           CASE WHEN pr.status IN ('submitted_to_accounting','accounting_checked') AND rq.status = 'rejected' THEN 'rejected' ELSE pr.status END AS status,
           (pr.status = 'submitted_to_accounting' AND EXISTS (SELECT 1 FROM platform.request_steps s JOIN platform.roles ro ON ro.id = s.approver_role_id
                WHERE s.request_id = pr.approval_request_id AND s.status = 'pending' AND ro.code = ANY(${myRoles(session)}::text[]))) AS awaiting_me
      FROM hr.payroll_runs pr LEFT JOIN platform.requests rq ON rq.id = pr.approval_request_id
     WHERE pr.status NOT IN ('draft', 'cancelled') ORDER BY pr.period DESC LIMIT 6`, { beforeHandle: moduleAccess('payroll', 'read') })

  .get('/payroll-review/runs/:id', async ({ params, session }) => {
    const run = await loadRun(params.id)
    if (run.status === 'draft') throw new HttpError(409, 'รอบนี้ HR ยังไม่ได้ส่งให้บัญชีตรวจ')
    const [[prev], deductions, adjustments, exceptions, checks, step] = await Promise.all([
      sql`SELECT net_pay::float8 AS net FROM hr.payroll_runs WHERE period < (SELECT period FROM hr.payroll_runs WHERE id = ${params.id}) AND status NOT IN ('draft','cancelled') ORDER BY period DESC LIMIT 1`,
      sql`SELECT CASE WHEN component IN ('SSO','TAX','PROVIDENT') THEN component ELSE 'OTHER' END AS component, sum(amount)::float8 AS amount
            FROM hr.payroll_items WHERE run_id = ${params.id} AND kind = 'deduction' GROUP BY 1 ORDER BY 1`,
      sql`SELECT component, kind, count(*)::int AS n, sum(amount)::float8 AS amount FROM hr.payroll_items WHERE run_id = ${params.id} AND source = 'adjustment' GROUP BY component, kind ORDER BY kind, component`,
      sql`SELECT x.id, e.full_name AS employee, x.description, x.confirmed_at FROM hr.payroll_exceptions x JOIN hr.employees e ON e.id = x.employee_id
           WHERE x.run_id = ${params.id} ORDER BY e.code, x.description`,
      runChecks(run),
      sql`SELECT EXISTS (SELECT 1 FROM platform.request_steps s JOIN platform.roles ro ON ro.id = s.approver_role_id
                WHERE s.request_id = ${run.approval_request_id} AND s.status = 'pending' AND ro.code = ANY(${myRoles(session)}::text[])) AS can_act`,
    ])
    const confirmed = exceptions.filter((e) => e.confirmed_at).length
    return {
      run: { ...run, change_pct: prev?.net ? r2(((run.net - prev.net) / prev.net) * 100) : null },
      deductions, adjustments, exceptions, checks,
      can_act: run.status === 'submitted_to_accounting' && step[0].can_act,
      ready: confirmed === exceptions.length && !checks.some((c) => c.status === 'fail'),
    }
  }, { beforeHandle: moduleAccess('payroll', 'read'), params: t.Object({ id: UUID }) })

  // ยืนยันรายการผิดปกติทีละรายการ (ต้องเป็นรอบที่รอบัญชีตรวจอยู่และผู้ยืนยันเป็นผู้ตรวจของขั้นนี้)
  .post('/payroll-review/exceptions/:id/confirm', async ({ params, session, ip }) => {
    const [x] = await sql`SELECT x.id, x.run_id, x.confirmed_at, pr.status, pr.approval_request_id, pr.run_no FROM hr.payroll_exceptions x JOIN hr.payroll_runs pr ON pr.id = x.run_id WHERE x.id = ${params.id}`
    if (!x) throw new HttpError(404, 'ไม่พบรายการ')
    if (x.status !== 'submitted_to_accounting') throw new HttpError(409, 'รอบนี้ไม่ได้อยู่ในขั้นตรวจของบัญชี')
    await pendingAccountingStep(x.approval_request_id, 'PAYROLL', session)
    if (x.confirmed_at) throw new HttpError(409, 'ยืนยันไปแล้ว')
    await sql.transaction([
      sql`UPDATE hr.payroll_exceptions SET confirmed_by = ${session.userId}, confirmed_at = now() WHERE id = ${params.id} AND confirmed_at IS NULL`,
      audit({ session, ip }, { action: 'confirm_payroll_exception', module: 'payroll', table: 'hr.payroll_exceptions', id: params.id, ref: x.run_no }),
    ])
    return { ok: true }
  }, { beforeHandle: moduleAccess('payroll', 'read'), params: t.Object({ id: UUID }) })

  // ผ่านการตรวจ: ยืนยันรายการผิดปกติครบ + ตรวจอัตโนมัติไม่มีข้อ fail → อนุมัติขั้นของบัญชี ส่งต่อผู้จัดการ
  .post('/payroll-review/runs/:id/pass', async ({ params, body, session, ip }) => {
    const run = await loadRun(params.id)
    await assertInReview(run)
    const req = await pendingAccountingStep(run.approval_request_id!, 'PAYROLL', session)
    const [{ open }] = await sql`SELECT count(*)::int AS open FROM hr.payroll_exceptions WHERE run_id = ${params.id} AND confirmed_at IS NULL`
    if (open > 0) throw new HttpError(409, `ยังมีรายการผิดปกติที่ยังไม่ยืนยัน ${open} รายการ`)
    const failed = (await runChecks(run)).filter((c) => c.status === 'fail')
    if (failed.length) throw new HttpError(409, `ตรวจอัตโนมัติไม่ผ่าน: ${failed.map((c) => c.label).join(' · ')}`)
    const note = body.note?.trim() || null
    await sql.transaction([
      ...approveStep(req, session.userId, note),
      sql`UPDATE hr.payroll_runs pr SET updated_at = now(),
                 status = CASE WHEN (SELECT status FROM platform.requests WHERE id = pr.approval_request_id) = 'approved' THEN 'approved' ELSE 'accounting_checked' END
           WHERE pr.id = ${params.id} AND pr.status = 'submitted_to_accounting'`,
      audit({ session, ip }, { action: 'pass_payroll_review', module: 'payroll', table: 'hr.payroll_runs', id: params.id, ref: run.run_no, after: { note }, risk: 'medium' }),
    ])
    return { ok: true }
  }, { beforeHandle: moduleAccess('payroll', 'read'), params: t.Object({ id: UUID }), body: t.Object({ note: t.Optional(t.String({ maxLength: 300 })) }) })

  // ส่งกลับ HR พร้อมหมายเหตุ (บังคับ) — คำขอถูกปฏิเสธ HR จะเห็นสถานะ "ถูกส่งกลับ" และเปิดแก้ไขได้
  .post('/payroll-review/runs/:id/return', async ({ params, body, session, ip }) => {
    const note = body.note.trim()
    if (!note) throw new HttpError(422, 'ต้องระบุหมายเหตุถึง HR')
    const run = await loadRun(params.id)
    await assertInReview(run)
    const req = await pendingAccountingStep(run.approval_request_id!, 'PAYROLL', session)
    await sql.transaction([
      ...rejectStep(req, session.userId, note),
      audit({ session, ip }, { action: 'return_payroll_to_hr', module: 'payroll', table: 'hr.payroll_runs', id: params.id, ref: run.run_no, after: { note }, risk: 'medium' }),
    ])
    return { ok: true }
  }, { beforeHandle: moduleAccess('payroll', 'read'), params: t.Object({ id: UUID }), body: t.Object({ note: t.String({ minLength: 1, maxLength: 300 }) }) })
