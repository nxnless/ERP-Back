import { Elysia } from 'elysia'
import { authenticated } from '../../auth/plugin'
import { sql } from '../../shared/db'
import { HttpError } from '../../shared/errors'

const ipOf = (h: Record<string, string | undefined>) => {
  const v = (h['x-forwarded-for']?.split(',')[0] ?? h['x-real-ip'] ?? '').trim()
  return /^[0-9a-fA-F:.]{3,45}$/.test(v) ? v : null // ใส่ลง audit_log.ip (inet) ได้เฉพาะที่เป็น IP จริง
}

/**
 * ด่านพื้นฐานของ Sales: ล็อกอินแล้ว + (มีบทบาท sales  หรือ  เป็นหัวหน้าแผนกขาย) ไม่ใช่ = 403
 *  หัวหน้าแผนกขาย = บทบาท dept_head ที่ทะเบียนพนักงาน (hr.employees) อยู่แผนกเดียวกับพนักงานที่มีบทบาท sales
 *  (ไม่ผูกรหัสแผนก — หัวหน้าแผนกอื่นจะไม่ผ่านด่านนี้)
 * ให้ `ip` (ไว้ลง audit), `branchId` (สาขาของผู้ใช้ — "ทีม" ระดับสาขา: เห็นร่วมกันได้) และ
 *   `teamIds` = ผู้ใช้ที่ "ดำเนินการแทนได้" — พนักงานขายทั่วไป = ตนเองคนเดียว · หัวหน้าแผนก = ตนเอง + ลูกน้องแผนกเดียวกันที่เป็น sales
 *   `isHead`
 */
export const salesOnly = new Elysia({ name: 'sales/guard' })
  .use(authenticated)
  .derive(async ({ headers, session }) => {
    const isSales = session.roles.includes('sales'), maybeHead = session.roles.includes('dept_head')
    if (!isSales && !maybeHead) throw new HttpError(403, 'เฉพาะฝ่ายขายเท่านั้น')
    const [u] = await sql`SELECT branch_id FROM platform.users WHERE id = ${session.userId}`
    let members: string[] = []
    if (maybeHead) {
      const rows = await sql`
        SELECT DISTINCT e2.user_id FROM hr.employees me
          JOIN hr.employees e2 ON e2.department_id = me.department_id AND e2.status <> 'resigned' AND e2.user_id IS NOT NULL
          JOIN platform.user_roles ur ON ur.user_id = e2.user_id JOIN platform.roles r ON r.id = ur.role_id AND r.code = 'sales'
         WHERE me.user_id = ${session.userId}`
      members = rows.map((r: any) => r.user_id as string)
    }
    const isHead = members.length > 0
    if (!isSales && !isHead) throw new HttpError(403, 'หัวหน้าแผนกที่ไม่ใช่แผนกขายใช้งานโมดูลนี้ไม่ได้')
    return { ip: ipOf(headers), branchId: (u?.branch_id ?? null) as string | null, isHead, teamIds: [...new Set([session.userId, ...(isHead ? members : [])])] as string[] }
  })
  .as('scoped')

/**
 * ตรวจสิทธิ์รายโมดูลตามที่ Admin ตั้งไว้ในหน้า "บทบาทและสิทธิ์" + สถานะเปิด/ปิดโมดูล
 * GET ต้องมีระดับ read ขึ้นไป · POST/PUT/DELETE ต้องมี write ขึ้นไป
 * ใช้: .use(moduleAccess('sales'))  หรือ  .use(moduleAccess('crm'))
 */
export const moduleAccess = (module: 'sales' | 'crm') =>
  new Elysia({ name: `sales/module/${module}` })
    .use(salesOnly)
    .onBeforeHandle(async ({ session, request }) => {
      const need = request.method === 'GET' ? 1 : 2
      const [r] = await sql`
        SELECT COALESCE(max(CASE a.level WHEN 'manage' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END), 0)::int AS lv,
               COALESCE(bool_and(m.enabled), false) AS enabled
          FROM platform.user_roles ur
          JOIN platform.role_module_access a ON a.role_id = ur.role_id AND a.module_code = ${module}
          JOIN platform.modules m ON m.code = a.module_code
         WHERE ur.user_id = ${session.userId}`
      if (!r?.enabled) throw new HttpError(403, 'โมดูลนี้ถูกปิดใช้งานหรือคุณไม่มีสิทธิ์เข้าใช้')
      if (r.lv < need) throw new HttpError(403, 'คุณมีสิทธิ์ดูอย่างเดียวในโมดูลนี้')
    })
    .as('scoped')
