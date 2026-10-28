import { Elysia, t } from 'elysia'
import { auth, sql, HttpError } from '../deps'
import { resolveRoute, insertRequest } from '../lib/route'
import { bangkokToday, bangkokYear, dayDiff, nextDocNo, withRetry } from '../lib/util'

const DATE = t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })

export const timeRoutes = new Elysia()
  .use(auth)

  // ---------- วันลาคงเหลือ ----------
  .get('/leave/balances', async ({ emp }) => {
    const year = bangkokYear()
    return sql`
      SELECT t.code, t.name, t.annual_days::float8 AS annual_days, t.notice_days, t.cert_required_from_days::float8 AS cert_from,
             COALESCE((SELECT sum(days) FROM hr.leave_ledger l WHERE l.employee_id = ${emp.id} AND l.leave_type_code = t.code AND l.year = ${year}), 0)::float8 AS balance,
             COALESCE((SELECT sum(days) FROM hr.leave_requests r WHERE r.employee_id = ${emp.id} AND r.leave_type_code = t.code
                        AND r.status = 'pending' AND extract(year FROM r.start_date) = ${year}), 0)::float8 AS pending
        FROM hr.leave_types t WHERE NOT t.statutory ORDER BY t.code`
  })

  // ---------- ลงเวลา ----------
  .get(
    '/attendance',
    async ({ emp, query }) => {
      const month = query.month ?? bangkokToday().slice(0, 7)
      const rows = await sql`
        SELECT work_date::text AS work_date, clock_in, clock_out, worked_hours::float8 AS worked_hours
          FROM hr.attendance
         WHERE employee_id = ${emp.id} AND work_date >= ${month + '-01'}::date AND work_date < (${month + '-01'}::date + interval '1 month')
         ORDER BY work_date DESC`
      const today = rows.find((r) => r.work_date === bangkokToday()) ?? null
      return { today, rows }
    },
    { query: t.Object({ month: t.Optional(t.String({ pattern: '^\\d{4}-\\d{2}$' })) }) },
  )
  .post('/attendance/clock-in', async ({ emp }) => {
    const r = await sql`
      INSERT INTO hr.attendance (employee_id, work_date, clock_in) VALUES (${emp.id}, ${bangkokToday()}::date, now())
      ON CONFLICT (employee_id, work_date) DO NOTHING RETURNING clock_in`
    if (!r.length) throw new HttpError(409, 'ลงเวลาเข้างานวันนี้แล้ว')
    return { clock_in: r[0].clock_in }
  })
  .post('/attendance/clock-out', async ({ emp }) => {
    const r = await sql`
      UPDATE hr.attendance SET clock_out = now()
       WHERE employee_id = ${emp.id} AND work_date = ${bangkokToday()}::date AND clock_in IS NOT NULL AND clock_out IS NULL AND now() > clock_in
   RETURNING clock_out`
    if (!r.length) throw new HttpError(409, 'ยังไม่ได้ลงเวลาเข้างาน หรือลงเวลาออกแล้ว')
    return { clock_out: r[0].clock_out }
  })

  // ---------- ยื่นใบลา ----------
  .post(
    '/leave-requests',
    async ({ emp, body }) => {
      const { leave_type_code: code, start_date: start, end_date: end, days } = body
      const [lt] = await sql`SELECT code, name, notice_days, cert_required_from_days::float8 AS cert_from FROM hr.leave_types WHERE code = ${code} AND NOT statutory`
      if (!lt) throw new HttpError(422, 'ประเภทการลาไม่ถูกต้อง')
      if (end < start) throw new HttpError(422, 'วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่ม')
      if (days > dayDiff(start, end) + 1) throw new HttpError(422, 'จำนวนวันลามากกว่าช่วงวันที่เลือก')
      if (lt.notice_days > 0 && dayDiff(bangkokToday(), start) < lt.notice_days)
        throw new HttpError(422, `${lt.name} ต้องแจ้งล่วงหน้าอย่างน้อย ${lt.notice_days} วัน`)

      const overlap = await sql`
        SELECT doc_no FROM hr.leave_requests WHERE employee_id = ${emp.id} AND status IN ('pending','approved')
           AND daterange(start_date, end_date, '[]') && daterange(${start}::date, ${end}::date, '[]') LIMIT 1`
      if (overlap.length) throw new HttpError(409, `ช่วงวันที่ซ้ำกับใบลา ${overlap[0].doc_no}`)

      const year = Number(start.slice(0, 4))
      const [b] = await sql`
        SELECT COALESCE((SELECT sum(days) FROM hr.leave_ledger WHERE employee_id = ${emp.id} AND leave_type_code = ${code} AND year = ${year}), 0)::float8
             - COALESCE((SELECT sum(days) FROM hr.leave_requests WHERE employee_id = ${emp.id} AND leave_type_code = ${code}
                          AND status = 'pending' AND extract(year FROM start_date) = ${year}), 0)::float8 AS available`
      const over = days > b.available
      const certMissing = lt.cert_from != null && days >= lt.cert_from && !body.certificate_attached
      const summary = `${lt.name} ${days} วัน (${start}${end !== start ? ' ถึง ' + end : ''})`
      const payload = { summary, over_quota: over, cert_missing: certMissing, assigned_manager_employee_id: emp.managerId }
      const steps = await resolveRoute('LEAVE', { userId: emp.userId, payload })

      return withRetry(async () => {
        const [reqNo, docNo] = await Promise.all([nextDocNo('REQ', 'platform.requests', 'request_no'), nextDocNo('LV', 'hr.leave_requests', 'doc_no')])
        const requestId = crypto.randomUUID(), leaveId = crypto.randomUUID()
        await sql.transaction([
          ...insertRequest({ id: requestId, requestNo: reqNo, type: 'LEAVE', userId: emp.userId, branchId: emp.branchId, refTable: 'hr.leave_requests', refId: leaveId, payload, steps }),
          sql`INSERT INTO hr.leave_requests (id, doc_no, employee_id, leave_type_code, start_date, end_date, days, reason, certificate_attached, over_quota, cert_missing, request_id)
              VALUES (${leaveId}, ${docNo}, ${emp.id}, ${code}, ${start}::date, ${end}::date, ${days}, ${body.reason ?? null}, ${body.certificate_attached ?? false}, ${over}, ${certMissing}, ${requestId})`,
        ])
        return { id: leaveId, doc_no: docNo, request_no: reqNo, over_quota: over, cert_missing: certMissing, route: steps.map((s) => s.name) }
      })
    },
    {
      body: t.Object({
        leave_type_code: t.String(), start_date: DATE, end_date: DATE,
        days: t.Number({ minimum: 0.5, maximum: 120 }), reason: t.Optional(t.String({ maxLength: 500 })), certificate_attached: t.Optional(t.Boolean()),
      }),
    },
  )

  // ---------- ขอทำ OT ----------
  .post(
    '/ot-requests',
    async ({ emp, body }) => {
      const gap = dayDiff(bangkokToday(), body.work_date)
      if (gap > 30 || gap < -30) throw new HttpError(422, 'ขอ OT ย้อนหลังหรือล่วงหน้าได้ไม่เกิน 30 วัน')
      const dup = await sql`SELECT 1 FROM hr.ot_requests WHERE employee_id = ${emp.id} AND work_date = ${body.work_date}::date AND status IN ('pending','approved')`
      if (dup.length) throw new HttpError(409, 'มีคำขอ OT ของวันนี้อยู่แล้ว')
      const payload = { summary: `OT ${body.hours} ชม. (${body.work_date})`, hours: body.hours }
      const steps = await resolveRoute('OT', { userId: emp.userId, payload })
      return withRetry(async () => {
        const reqNo = await nextDocNo('REQ', 'platform.requests', 'request_no')
        const requestId = crypto.randomUUID(), otId = crypto.randomUUID()
        await sql.transaction([
          ...insertRequest({ id: requestId, requestNo: reqNo, type: 'OT', userId: emp.userId, branchId: emp.branchId, refTable: 'hr.ot_requests', refId: otId, payload, steps }),
          sql`INSERT INTO hr.ot_requests (id, employee_id, work_date, hours, reason, request_id)
              VALUES (${otId}, ${emp.id}, ${body.work_date}::date, ${body.hours}, ${body.reason ?? null}, ${requestId})`,
        ])
        return { id: otId, request_no: reqNo, route: steps.map((s) => s.name) }
      })
    },
    { body: t.Object({ work_date: DATE, hours: t.Number({ minimum: 0.5, maximum: 12, multipleOf: 0.5 }), reason: t.Optional(t.String({ maxLength: 500 })) }) },
  )
