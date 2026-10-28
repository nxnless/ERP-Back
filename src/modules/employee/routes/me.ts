import { Elysia, t } from 'elysia'
import { auth, sql } from '../deps'
import { resolveRoute } from '../lib/route'

export const meRoutes = new Elysia()
  .use(auth)
  // ข้อมูลหัวเมนู: ชื่อ ตำแหน่ง จำนวนคำขอที่รอดำเนินการ
  .get('/me', async ({ emp }) => {
    const [row] = await sql`
      SELECT e.code, e.full_name, e.position, d.name AS department, m.full_name AS manager_name,
             (SELECT count(*)::int FROM platform.requests q WHERE q.requester_id = ${emp.userId} AND q.status = 'pending') AS pending_requests
        FROM hr.employees e LEFT JOIN master.departments d ON d.id = e.department_id LEFT JOIN hr.employees m ON m.id = e.manager_id
       WHERE e.id = ${emp.id}`
    return row
  })
  // รายการสินค้าสำหรับฟอร์ม PR / เบิกสินค้า (ไม่ส่งราคา/ต้นทุน)
  .get('/lookups/items', async () => await sql`SELECT id, sku, name, uom FROM master.items WHERE active ORDER BY name`)
  // แสดงเส้นทางอนุมัติล่วงหน้าก่อนกดส่ง
  .get(
    '/route-preview',
    async ({ emp, query }) => {
      const steps = await resolveRoute(query.type, { userId: emp.userId, amount: query.amount, payload: { over_quota: query.over_quota === 'true' } })
      return steps.map((s) => s.name)
    },
    { query: t.Object({ type: t.String(), amount: t.Optional(t.Numeric()), over_quota: t.Optional(t.String()) }) },
  )
