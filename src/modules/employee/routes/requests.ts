import { Elysia, t } from 'elysia'
import { auth, sql, HttpError } from '../deps'
import { resolveRoute, insertRequest } from '../lib/route'
import { bangkokToday, dayDiff, nextDocNo, withRetry } from '../lib/util'

const DATE = t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })
const Line = t.Object({
  item_id: t.Optional(t.String({ format: 'uuid' })), description: t.String({ minLength: 1, maxLength: 200 }),
  qty: t.Number({ exclusiveMinimum: 0 }), uom: t.String({ minLength: 1, maxLength: 20 }), est_unit_price: t.Optional(t.Number({ minimum: 0 })),
})

export const requestRoutes = new Elysia()
  .use(auth)

  // คำขอทั้งหมดของฉัน พร้อมขั้นอนุมัติ
  .get('/requests', async ({ emp }) => {
    const rows = await sql`
    SELECT r.id, r.request_no, r.type, r.status, r.amount::float8 AS amount, r.payload, r.created_at, r.decided_at,
           COALESCE((SELECT json_agg(json_build_object('seq', s.seq, 'role', ro.name, 'status', s.status, 'comment', s.comment, 'acted_at', s.acted_at) ORDER BY s.seq)
                       FROM platform.request_steps s JOIN platform.roles ro ON ro.id = s.approver_role_id WHERE s.request_id = r.id), '[]'::json) AS steps
      FROM platform.requests r WHERE r.requester_id = ${emp.userId} ORDER BY r.created_at DESC LIMIT 100`
    return rows
  })

  // ยกเลิกคำขอที่ยังรออยู่ (เจ้าของเท่านั้น)
  .post('/requests/:id/cancel', async ({ emp, params }) => {
    const [r] = await sql`SELECT id, status FROM platform.requests WHERE id = ${params.id} AND requester_id = ${emp.userId}`
    if (!r) throw new HttpError(404, 'ไม่พบคำขอ')
    if (r.status !== 'pending') throw new HttpError(409, 'คำขอนี้ดำเนินการไปแล้ว ยกเลิกไม่ได้')
    await sql.transaction([
      sql`UPDATE platform.requests SET status = 'cancelled', decided_at = now() WHERE id = ${r.id}`,
      sql`UPDATE platform.request_steps SET status = 'skipped' WHERE request_id = ${r.id} AND status IN ('waiting','pending')`,
      sql`UPDATE hr.leave_requests SET status = 'cancelled' WHERE request_id = ${r.id} AND status = 'pending'`,
      sql`UPDATE hr.ot_requests SET status = 'cancelled' WHERE request_id = ${r.id} AND status = 'pending'`,
      sql`UPDATE purchasing.purchase_requisitions SET status = 'cancelled' WHERE approval_request_id = ${r.id} AND status = 'pending_approval'`,
      sql`UPDATE hr.employee_bank_accounts SET status = 'rejected' WHERE request_id = ${r.id} AND status = 'pending_verification'`,
    ])
    return { ok: true }
  }, { params: t.Object({ id: t.String({ format: 'uuid' }) }) })

  // คำขออื่น ๆ: เบิกค่าใช้จ่าย / ขอซื้อ (PR) / ขอเบิกสินค้า / ขอแก้ข้อมูลที่ล็อก
  .post(
    '/requests',
    async ({ emp, body }) => {
      let amount = 0, summary = '', payload: Record<string, unknown> = {}
      const requestId = crypto.randomUUID(), prId = crypto.randomUUID()
      let refTable: string | undefined, refId: string | undefined

      if (body.type === 'EXPENSE') {
        if (dayDiff(body.expense_date, bangkokToday()) < 0) throw new HttpError(422, 'วันที่เกิดค่าใช้จ่ายต้องไม่เป็นอนาคต')
        amount = body.amount
        summary = `เบิกค่าใช้จ่าย ${body.category} ${amount.toLocaleString('th-TH')} บาท`
        payload = { summary, category: body.category, expense_date: body.expense_date, receipt_no: body.receipt_no, description: body.description }
      } else if (body.type === 'DATA_CHANGE') {
        summary = `ขอแก้ ${body.field} เป็น "${body.new_value}"`
        payload = { summary, field: body.field, new_value: body.new_value, reason: body.reason }
      } else if (body.type === 'ISSUE') {
        summary = `ขอเบิกสินค้า ${body.lines.length} รายการ · ${body.purpose}`
        payload = { summary, purpose: body.purpose, lines: body.lines.map((l) => ({ item_id: l.item_id ?? null, description: l.description, qty: l.qty, uom: l.uom })) }
      } else {
        // PR: สร้างใบขอซื้อจริง + รายการ
        amount = body.lines.reduce((s, l) => s + l.qty * (l.est_unit_price ?? 0), 0)
        summary = `ขอซื้อ ${body.lines[0].description}${body.lines.length > 1 ? ` และอีก ${body.lines.length - 1} รายการ` : ''}`
        payload = { summary, need_by: body.need_by, reason: body.reason ?? null }
        refTable = 'purchasing.purchase_requisitions'; refId = prId
      }
      const steps = await resolveRoute(body.type, { userId: emp.userId, amount, payload })

      return withRetry(async () => {
        const reqNo = await nextDocNo('REQ', 'platform.requests', 'request_no')
        const queries: any[] = [...insertRequest({ id: requestId, requestNo: reqNo, type: body.type, userId: emp.userId, branchId: emp.branchId, amount, refTable, refId, payload, steps })]
        let docNo: string | null = null
        if (body.type === 'PR') {
          docNo = await nextDocNo('PR', 'purchasing.purchase_requisitions', 'doc_no')
          queries.push(sql`INSERT INTO purchasing.purchase_requisitions (id, doc_no, requester_id, department_id, branch_id, need_by, reason, status, approval_request_id)
                           VALUES (${prId}, ${docNo}, ${emp.userId}, ${emp.departmentId}, ${emp.branchId}, ${body.need_by}::date, ${body.reason ?? null}, 'pending_approval', ${requestId})`)
          body.lines.forEach((l, i) => queries.push(sql`
            INSERT INTO purchasing.pr_lines (pr_id, line_no, item_id, description, qty, uom, est_unit_price)
            VALUES (${prId}, ${i + 1}, ${l.item_id ?? null}, ${l.description}, ${l.qty}, ${l.uom}, ${l.est_unit_price ?? 0})`))
        }
        await sql.transaction(queries)
        return { id: requestId, request_no: reqNo, doc_no: docNo, route: steps.map((s) => s.name) }
      })
    },
    {
      body: t.Union([
        t.Object({ type: t.Literal('EXPENSE'), category: t.String({ minLength: 1 }), expense_date: DATE, amount: t.Number({ exclusiveMinimum: 0, maximum: 10000000 }), receipt_no: t.String({ minLength: 1, maxLength: 60 }), description: t.String({ minLength: 1, maxLength: 300 }) }),
        t.Object({ type: t.Literal('PR'), need_by: DATE, reason: t.Optional(t.String({ maxLength: 300 })), lines: t.Array(Line, { minItems: 1, maxItems: 20 }) }),
        t.Object({ type: t.Literal('ISSUE'), purpose: t.String({ minLength: 1, maxLength: 200 }), lines: t.Array(Line, { minItems: 1, maxItems: 20 }) }),
        t.Object({ type: t.Literal('DATA_CHANGE'), field: t.String({ minLength: 1 }), new_value: t.String({ minLength: 1, maxLength: 200 }), reason: t.String({ minLength: 1, maxLength: 300 }) }),
      ]),
    },
  )
