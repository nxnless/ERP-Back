import { Elysia, t } from 'elysia'
import { auth, sql, HttpError } from '../deps'
import { resolveRoute, insertRequest } from '../lib/route'
import { encryptHex } from '../lib/crypto'
import { nextDocNo, withRetry } from '../lib/util'

export const profileRoutes = new Elysia()
  .use(auth)
  .get('/profile', async ({ emp }) => {
    const [p] = await sql`
      SELECT e.code, e.full_name, e.position, d.name AS department, e.hire_date::text AS hire_date, m.full_name AS manager_name,
             e.phone, e.personal_email, e.address, e.emergency_name, e.emergency_relation, e.emergency_phone, e.updated_at
        FROM hr.employees e LEFT JOIN master.departments d ON d.id = e.department_id LEFT JOIN hr.employees m ON m.id = e.manager_id
       WHERE e.id = ${emp.id}`
    const bank = await sql`
      SELECT id, bank_name, account_last4, status, created_at FROM hr.employee_bank_accounts
       WHERE employee_id = ${emp.id} AND status IN ('active','pending_verification') ORDER BY created_at DESC`
    return { ...p, bank_active: bank.find((b) => b.status === 'active') ?? null, bank_pending: bank.find((b) => b.status === 'pending_verification') ?? null }
  })

  // แก้ได้เฉพาะข้อมูลติดต่อ — ชื่อ/ตำแหน่ง/วันเริ่มงานต้องขอผ่าน HR
  .put(
    '/profile/contact',
    async ({ emp, body }) => {
      await sql`
        UPDATE hr.employees SET phone = ${body.phone}, personal_email = ${body.personal_email}, address = ${body.address},
               emergency_name = ${body.emergency_name}, emergency_relation = ${body.emergency_relation}, emergency_phone = ${body.emergency_phone}
         WHERE id = ${emp.id}`
      return { ok: true }
    },
    {
      body: t.Object({
        phone: t.String({ pattern: '^0[0-9-]{8,11}$' }),
        personal_email: t.String({ pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' }),
        address: t.String({ maxLength: 300 }),
        emergency_name: t.String({ maxLength: 100 }), emergency_relation: t.String({ maxLength: 50 }),
        emergency_phone: t.String({ pattern: '^0[0-9-]{8,11}$' }),
      }),
    },
  )

  // เปลี่ยนบัญชีรับเงินเดือน → รอ HR ตรวจสอบ (ระหว่างนั้นยังใช้บัญชีเดิม)
  .post(
    '/profile/bank-change',
    async ({ emp, body }) => {
      const digits = body.account_no.replace(/\D/g, '')
      if (digits.length < 10 || digits.length > 12) throw new HttpError(422, 'เลขบัญชีต้องมี 10–12 หลัก')
      const pending = await sql`SELECT 1 FROM hr.employee_bank_accounts WHERE employee_id = ${emp.id} AND status = 'pending_verification'`
      if (pending.length) throw new HttpError(409, 'มีคำขอเปลี่ยนบัญชีที่รอ HR ตรวจสอบอยู่แล้ว')

      const last4 = digits.slice(-4)
      const payload = { summary: `เปลี่ยนบัญชีรับเงินเดือนเป็น ${body.bank_name} xxx-x-x${last4}`, bank_name: body.bank_name, last4 }
      const steps = await resolveRoute('BANK_CHANGE', { userId: emp.userId, payload })
      const enc = await encryptHex(digits)
      return withRetry(async () => {
        const reqNo = await nextDocNo('REQ', 'platform.requests', 'request_no')
        const requestId = crypto.randomUUID(), bankId = crypto.randomUUID()
        await sql.transaction([
          ...insertRequest({ id: requestId, requestNo: reqNo, type: 'BANK_CHANGE', userId: emp.userId, branchId: emp.branchId, refTable: 'hr.employee_bank_accounts', refId: bankId, payload, steps }),
          sql`INSERT INTO hr.employee_bank_accounts (id, employee_id, bank_name, account_last4, account_no_enc, status, request_id)
              VALUES (${bankId}, ${emp.id}, ${body.bank_name}, ${last4}, decode(${enc}, 'hex'), 'pending_verification', ${requestId})`,
        ])
        return { request_no: reqNo, route: steps.map((s) => s.name) }
      })
    },
    { body: t.Object({ bank_name: t.String({ minLength: 1, maxLength: 60 }), account_no: t.String({ minLength: 10, maxLength: 20 }) }) },
  )
