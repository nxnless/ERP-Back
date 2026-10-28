import { Elysia } from 'elysia'
import { sql } from '../../../shared/db'
import { hrOnly, moduleAccess } from '../guard'

// พนักงานที่ "ทำงานอยู่" ณ วันที่หนึ่ง = เริ่มงานแล้ว และยังไม่มีวันสิ้นสุด (หรือสิ้นสุดหลังวันนั้น)
export const headcountRoutes = new Elysia()
  .use(hrOnly)
  .get('/headcount', async () => {
    const [[k], byDept, monthly] = await Promise.all([
      sql`SELECT count(*) FILTER (WHERE hire_date <= current_date AND (termination_date IS NULL OR termination_date >= current_date))::int AS actual,
                 count(*) FILTER (WHERE status = 'probation' AND hire_date <= current_date AND (termination_date IS NULL OR termination_date >= current_date))::int AS probation,
                 count(*) FILTER (WHERE hire_date >= date_trunc('month', current_date) AND hire_date <= current_date)::int AS joined_this_month,
                 count(*) FILTER (WHERE termination_date >= date_trunc('year', current_date) AND termination_date <= current_date)::int AS resigned_ytd
            FROM hr.employees`,
      sql`SELECT d.name AS department, d.planned_headcount AS planned,
                 count(e.id) FILTER (WHERE e.hire_date <= current_date AND (e.termination_date IS NULL OR e.termination_date >= current_date))::int AS actual,
                 count(e.id) FILTER (WHERE e.termination_date >= date_trunc('year', current_date) AND e.termination_date <= current_date)::int AS resigned_ytd
            FROM master.departments d LEFT JOIN hr.employees e ON e.department_id = d.id
           WHERE d.active GROUP BY d.id, d.name, d.planned_headcount ORDER BY d.code`,
      sql`SELECT to_char(m, 'YYYY-MM') AS month,
                 (SELECT count(*)::int FROM hr.employees e
                   WHERE e.hire_date <= (m + interval '1 month' - interval '1 day')::date
                     AND (e.termination_date IS NULL OR e.termination_date > (m + interval '1 month' - interval '1 day')::date)) AS n
            FROM generate_series(date_trunc('month', current_date) - interval '5 months', date_trunc('month', current_date), interval '1 month') AS m ORDER BY m`,
    ])
    const planned = byDept.reduce((s, d) => s + d.planned, 0)
    const avg = monthly.length ? Math.round(monthly.reduce((s, m) => s + m.n, 0) / monthly.length) : 0
    return { ...k, planned, vacant: Math.max(0, planned - k.actual), avg_headcount: avg, by_department: byDept, monthly }
  }, { beforeHandle: moduleAccess('hr', 'read') })
