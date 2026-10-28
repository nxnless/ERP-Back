import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { moduleAccess } from '../guard'
import { audit } from '../lib/audit'
import { UUID } from '../lib/rules'

/** CRM Pipeline — เห็นโอกาสขายของตนและทีม (สาขาเดียวกัน) · ย้ายขั้นได้เฉพาะของตนเอง (หัวหน้าแผนก: รวมลูกทีมในแผนก) */
export const crmRoutes = new Elysia()
  .use(moduleAccess('crm'))
  .get('/pipeline', async ({ session, branchId, teamIds }) => ({
    stages: await sql`SELECT code, name, seq, probability FROM sales.crm_stages ORDER BY seq`,
    opportunities: await sql`
      SELECT o.id, o.company_name, o.amount::float8 AS amount, o.stage_code, o.next_step, o.next_step_date, o.expected_close, o.updated_at,
             (o.owner_id = ${session.userId}) AS own, (o.owner_id = ANY(${teamIds}::uuid[])) AS mine, u.display_name AS owner_name
        FROM sales.opportunities o JOIN platform.users u ON u.id = o.owner_id
       WHERE o.owner_id = ANY(${teamIds}::uuid[]) OR o.branch_id = ${branchId}::uuid
       ORDER BY o.updated_at DESC LIMIT 500`,
  }))

  .post('/opportunities', async ({ body, session, ip, branchId }) => {
    const [first] = await sql`SELECT code FROM sales.crm_stages ORDER BY seq LIMIT 1`
    if (!first) throw new HttpError(422, 'ยังไม่ได้ตั้งค่าขั้นของ Pipeline — รัน sales/seed.sql')
    const id = crypto.randomUUID(), name = body.company_name.trim()
    await sql.transaction([
      sql`INSERT INTO sales.opportunities (id, company_name, owner_id, branch_id, stage_code, amount, next_step)
          VALUES (${id}, ${name}, ${session.userId}, ${branchId}, ${first.code}, ${body.amount ?? 0}, ${body.next_step?.trim() || 'ติดต่อครั้งแรก'})`,
      audit({ session, ip }, { module: 'crm', action: 'create_lead', table: 'sales.opportunities', id, ref: name, after: { amount: body.amount ?? 0, stage: first.code } }),
    ])
    return { id }
  }, { body: t.Object({ company_name: t.String({ minLength: 1, maxLength: 150 }), amount: t.Optional(t.Number({ minimum: 0, maximum: 1_000_000_000 })), next_step: t.Optional(t.String({ maxLength: 200 })) }) })

  // ย้ายขั้นได้ทีละ 1 (ถอย/เดินหน้า)
  .put('/opportunities/:id/stage', async ({ params, body, session, ip, teamIds }) => {
    const [o] = await sql`SELECT id, company_name, owner_id, stage_code FROM sales.opportunities WHERE id = ${params.id}`
    if (!o) throw new HttpError(404, 'ไม่พบรายการ')
    if (!teamIds.includes(o.owner_id)) throw new HttpError(403, 'ย้ายขั้นได้เฉพาะรายการของตนเอง (หัวหน้าแผนก: รวมของลูกทีมในแผนก)')
    const stages = await sql`SELECT code, seq, probability FROM sales.crm_stages`
    const from = stages.find((s) => s.code === o.stage_code), to = stages.find((s) => s.code === body.stage_code)
    if (!from || !to) throw new HttpError(422, 'ไม่พบขั้นของ Pipeline')
    if (Math.abs(to.seq - from.seq) !== 1) throw new HttpError(422, 'ย้ายได้ทีละ 1 ขั้น')
    const won = to.probability === 100
    await sql.transaction([
      sql`UPDATE sales.opportunities SET stage_code = ${to.code}, expected_close = CASE WHEN ${won} THEN current_date ELSE expected_close END, updated_at = now() WHERE id = ${o.id}`,
      audit({ session, ip }, { module: 'crm', action: 'move_stage', table: 'sales.opportunities', id: o.id, ref: o.company_name, before: { stage: from.code }, after: { stage: to.code } }),
    ])
    return { ok: true, won }
  }, { params: t.Object({ id: UUID }), body: t.Object({ stage_code: t.String() }) })
