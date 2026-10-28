import { Elysia } from 'elysia'
import { sql } from '../../../shared/db'
import { managerOnly } from '../guard'
import { APPROVAL_LIMIT } from '../lib/rules'

export const meRoutes = new Elysia()
  .use(managerOnly)
  // ข้อมูลสำหรับเมนู: ชื่อ สาขา วงเงิน และจำนวนที่รออนุมัติ (ตัวเลขกำกับเมนู)
  .get('/me', async ({ session, branchId }) => {
    const [[b], [c]] = await Promise.all([
      sql`SELECT name FROM platform.branches WHERE id = ${branchId}`,
      sql`SELECT count(*)::int AS n
            FROM platform.requests r
            JOIN platform.request_steps s ON s.request_id = r.id AND s.status = 'pending'
            JOIN platform.roles ro ON ro.id = s.approver_role_id AND ro.code = 'manager'
           WHERE r.status = 'pending' AND r.branch_id = ${branchId} AND r.requester_id <> ${session.userId}`,
    ])
    return { name: session.name, branch: b?.name ?? null, limit: APPROVAL_LIMIT, pending: c.n }
  })
