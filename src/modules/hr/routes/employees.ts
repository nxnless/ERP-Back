import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { hrOnly, moduleAccess } from '../guard'
import { audit } from '../lib/audit'
import { prepareRequest } from '../lib/requests'
import { BLOCKED_ROLES, DATE, UUID } from '../lib/rules'

const EMAIL = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'

export const employeeRoutes = new Elysia()
  .use(hrOnly)
  // แผนก สาขา และบทบาทที่ขอเปิดบัญชีได้ สำหรับฟอร์มเพิ่มพนักงาน
  .get('/meta', async () => ({
    departments: await sql`SELECT id, code, name FROM master.departments WHERE active ORDER BY code`,
    branches: await sql`SELECT id, code, name FROM platform.branches WHERE active ORDER BY code`,
    roles: await sql`SELECT code, name FROM platform.roles WHERE code <> ALL(${BLOCKED_ROLES}::text[]) ORDER BY (code = 'employee') DESC, name`,
  }), { beforeHandle: moduleAccess('hr', 'read') })

  // ทะเบียนพนักงาน — ไม่ส่งเงินเดือนมาในรายการ (ดูได้ทีละคนที่ /compensation และถูกบันทึก Audit)
  .get('/employees', async ({ query }) => {
    const q = query.q?.trim() || null, dept = query.department || null
    const rows = await sql`
      SELECT e.id, e.code AS employee_no, e.full_name, e.position, d.name AS department, e.department_id, b.name AS branch_name,
             e.hire_date, e.termination_date AS end_date, e.status, (e.user_id IS NOT NULL) AS has_account
        FROM hr.employees e
        LEFT JOIN master.departments d ON d.id = e.department_id
        LEFT JOIN platform.branches b ON b.id = e.branch_id
       WHERE (${q}::text IS NULL OR e.full_name ILIKE '%' || ${q} || '%' OR e.position ILIKE '%' || ${q} || '%' OR e.code ILIKE '%' || ${q} || '%')
         AND (${dept}::uuid IS NULL OR e.department_id = ${dept})
       ORDER BY e.code LIMIT 500`
    const [c] = await sql`SELECT count(*)::int AS n FROM hr.employees WHERE status <> 'resigned'`
    return { total: c.n, rows }
  }, { beforeHandle: moduleAccess('hr', 'read'), query: t.Object({ q: t.Optional(t.String({ maxLength: 100 })), department: t.Optional(UUID) }) })

  // เปิดดูเงินเดือน/เบี้ยตำแหน่งรายคน (ค่าที่มีผล ณ วันนี้) — ทุกครั้งมี Audit Log + audit.sensitive_access
  // ถ้าบันทึกไม่สำเร็จ จะไม่ส่งตัวเลขกลับ
  .get('/employees/:id/compensation', async ({ params, session, ip }) => {
    const [e] = await sql`
      SELECT e.code, c.base_salary::float8 AS base_salary, c.allowance::float8 AS allowance
        FROM hr.employees e
        LEFT JOIN LATERAL (SELECT * FROM hr.compensation x WHERE x.employee_id = e.id AND x.effective_from <= current_date ORDER BY x.effective_from DESC LIMIT 1) c ON true
       WHERE e.id = ${params.id}`
    if (!e) throw new HttpError(404, 'ไม่พบพนักงาน')
    await sql.transaction([
      audit({ session, ip }, { action: 'view_salary', module: 'payroll', table: 'hr.compensation', id: params.id, ref: e.code, risk: 'medium' }),
      sql`INSERT INTO audit.sensitive_access (user_id, resource, resource_id, ip) VALUES (${session.userId}, 'hr.compensation', ${params.id}, ${ip}::inet)`,
    ])
    return { base_salary: e.base_salary ?? 0, allowance: e.allowance ?? 0 }
  }, { beforeHandle: moduleAccess('payroll', 'read'), params: t.Object({ id: UUID }) })

  // เพิ่มพนักงานใหม่ (สถานะทดลองงาน) + ส่งคำขอเปิดบัญชีผู้ใช้ให้ Admin ในธุรกรรมเดียวกัน
  .post('/employees', async ({ body, session, ip }) => {
    if (!(await sql`SELECT 1 FROM master.departments WHERE id = ${body.department_id} AND active`).length) throw new HttpError(422, 'ไม่พบแผนก')
    if (body.branch_id && !(await sql`SELECT 1 FROM platform.branches WHERE id = ${body.branch_id}`).length) throw new HttpError(422, 'ไม่พบสาขา')
    const email = body.email?.trim().toLowerCase() || null
    if (email && (await sql`SELECT 1 FROM platform.users WHERE lower(email) = ${email}`).length) throw new HttpError(409, 'อีเมลนี้มีผู้ใช้อยู่แล้ว')
    const role = body.requested_role ?? 'employee'
    if (!(await sql`SELECT 1 FROM platform.roles WHERE code = ${role} AND code <> ALL(${BLOCKED_ROLES}::text[])`).length) throw new HttpError(422, 'บทบาทที่ขอไม่ถูกต้อง')

    const name = body.full_name.trim(), pos = body.position.trim(), id = crypto.randomUUID()
    const hire = body.hire_date ?? new Date().toISOString().slice(0, 10)
    const [{ code }] = await sql`
      SELECT 'E' || lpad((COALESCE(max(substr(code, 2)::int), 0) + 1)::text, 3, '0') AS code FROM hr.employees WHERE code ~ '^E[0-9]+$'`
    const req = await prepareRequest({
      type: 'ACCOUNT', requesterId: session.userId,
      payload: { summary: `เปิดบัญชีให้ ${name} (${pos})`, name, email, position: pos, employee_id: id, requested_role: role },
    })
    await sql.transaction([
      sql`INSERT INTO hr.employees (id, code, full_name, position, department_id, branch_id, hire_date, status)
          VALUES (${id}, ${code}, ${name}, ${pos}, ${body.department_id}, ${body.branch_id ?? null}, ${hire}::date, 'probation')`,
      sql`INSERT INTO hr.employment_history (employee_id, effective_from, position, department_id, change_reason)
          VALUES (${id}, ${hire}::date, ${pos}, ${body.department_id}, 'จ้างใหม่')`,
      sql`INSERT INTO hr.compensation (employee_id, effective_from, base_salary, allowance) VALUES (${id}, ${hire}::date, ${body.base_salary}, ${body.allowance ?? 0})`,
      ...req.queries,
      audit({ session, ip }, { action: 'create_employee', table: 'hr.employees', id, ref: code,
        after: { full_name: name, position: pos, department_id: body.department_id, status: 'probation', account_request: req.request_no } }),
    ])
    return { id, employee_no: code, request_no: req.request_no }
  }, {
    beforeHandle: [moduleAccess('hr', 'write'), moduleAccess('payroll', 'write')],
    body: t.Object({
      full_name: t.String({ minLength: 1, maxLength: 100 }), position: t.String({ minLength: 1, maxLength: 100 }), department_id: UUID,
      email: t.Optional(t.String({ pattern: EMAIL, maxLength: 254 })), branch_id: t.Optional(UUID), hire_date: t.Optional(DATE),
      base_salary: t.Number({ minimum: 1 }), allowance: t.Optional(t.Number({ minimum: 0 })), requested_role: t.Optional(t.String()),
    }),
  })
