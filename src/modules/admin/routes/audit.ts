import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { adminOnly } from '../guard'

// Admin ดู Audit Log ได้ แต่ "ค่าก่อน–หลัง" เห็นเฉพาะเหตุการณ์ของระบบตั้งค่า (platform/auth)
// เหตุการณ์ของโมดูลธุรกิจ (เงินเดือน บัญชี ขาย ฯลฯ) เห็นแค่ใคร/ทำอะไร/เมื่อไร — ค่าถูกซ่อน เพื่อให้ Admin ไม่เห็นข้อมูลธุรกิจ
const OPEN = ['platform', 'auth']

export const auditRoutes = new Elysia()
  .use(adminOnly)
  .get(
    '/audit',
    async ({ query }) => {
      const limit = Math.min(query.limit ?? 50, 200), offset = query.offset ?? 0
      const m = query.module || null, risk = query.risk || null, q = query.q?.trim() || null, from = query.from || null, to = query.to || null
      // sql`` ซ้อนกันไม่ได้ (ตัวแปรใน template จะกลายเป็นพารามิเตอร์) จึงใช้ sql.query พร้อมเลขพารามิเตอร์
      const where = `($1::text IS NULL OR module = $1) AND ($2::text IS NULL OR risk = $2)
        AND ($3::text IS NULL OR actor_name ILIKE '%' || $3 || '%' OR action ILIKE '%' || $3 || '%' OR entity_ref ILIKE '%' || $3 || '%')
        AND ($4::date IS NULL OR occurred_at >= $4::date) AND ($5::date IS NULL OR occurred_at < $5::date + 1)`
      const f = [m, risk, q, from, to]
      const [rows, total, modules] = await Promise.all([
        sql.query(
          `SELECT id, occurred_at, actor_name, actor_roles, action, module, entity_table, entity_ref, risk, host(ip) AS ip,
                  CASE WHEN module = ANY($8::text[]) THEN before END AS before, CASE WHEN module = ANY($8::text[]) THEN after END AS after,
                  NOT (module = ANY($8::text[])) AS masked
             FROM audit.audit_log WHERE ${where} ORDER BY occurred_at DESC, id DESC LIMIT $6 OFFSET $7`,
          [...f, limit, offset, OPEN],
        ),
        sql.query(`SELECT count(*)::int AS n FROM audit.audit_log WHERE ${where}`, f),
        sql`SELECT DISTINCT module FROM audit.audit_log ORDER BY module`,
      ])
      return { rows, total: total[0].n, limit, offset, modules: modules.map((x) => x.module) }
    },
    { query: t.Object({ module: t.Optional(t.String()), risk: t.Optional(t.String()), q: t.Optional(t.String({ maxLength: 100 })),
        from: t.Optional(t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })), to: t.Optional(t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
        limit: t.Optional(t.Numeric()), offset: t.Optional(t.Numeric()) }) },
  )
