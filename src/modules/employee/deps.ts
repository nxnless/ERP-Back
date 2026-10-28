// จุดเชื่อมของโมดูลพนักงานกับระบบหลัก (db · error · login) — ถ้าโครงโปรเจคต่างจากนี้ แก้ที่ไฟล์นี้ไฟล์เดียว
import { Elysia } from 'elysia'
import { sql } from '../../shared/db'
import { HttpError } from '../../shared/errors'
import { sessionFromHeaders } from '../../auth/session'

export { sql, HttpError }

export type Emp = {
  id: string // hr.employees.id
  userId: string // platform.users.id
  code: string
  fullName: string
  position: string
  branchId: string | null
  departmentId: string | null
  managerId: string | null
}

/** plugin: ใส่ emp (ข้อมูลพนักงานของผู้ที่ล็อกอิน) ให้ทุก route — ทุก query ต้องกรองด้วย emp.id / emp.userId เสมอ */
export const auth = new Elysia({ name: 'employee/auth' }).derive({ as: 'scoped' }, async ({ headers }) => {
  const { userId } = await sessionFromHeaders(headers) // ไม่ล็อกอิน/บัญชีถูกระงับ = 401
  const rows = await sql`
    SELECT e.id, e.code, e.full_name, e.position, e.branch_id, e.department_id, e.manager_id
      FROM hr.employees e
     WHERE e.user_id = ${userId} AND e.status <> 'resigned'`
  const r = rows[0]
  if (!r) throw new HttpError(403, 'บัญชีนี้ยังไม่มีข้อมูลพนักงาน กรุณาติดต่อฝ่ายบุคคล')
  const emp: Emp = {
    id: r.id, userId, code: r.code, fullName: r.full_name, position: r.position,
    branchId: r.branch_id, departmentId: r.department_id, managerId: r.manager_id,
  }
  return { emp }
})
