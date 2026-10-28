import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { adminOnly } from '../guard'
import { audit } from '../lib/audit'
import { DOC_TYPES, UUID } from '../lib/rules'

type PolicyIn = { doc_type: string; min_amount: number; max_amount?: number | null; step_order: number; approver_role_id: string; condition_key?: string | null; active?: boolean }

/** ตรวจนโยบายก่อนบันทึก: ผู้อนุมัติต้องอนุมัติได้, วงเงินสมเหตุสมผล, ไม่ซ้อนกับขั้นเดิมที่ใช้งานอยู่ */
async function validate(p: PolicyIn, selfId: string | null) {
  if (!DOC_TYPES[p.doc_type]) throw new HttpError(422, 'ประเภทเอกสารไม่ถูกต้อง')
  if (p.max_amount != null && p.max_amount < p.min_amount) throw new HttpError(422, 'วงเงินสูงสุดต้องไม่น้อยกว่าวงเงินต่ำสุด')
  if (p.condition_key && !(p.condition_key === 'over_quota' && p.doc_type === 'LEAVE')) throw new HttpError(422, 'เงื่อนไขพิเศษใช้ได้เฉพาะ "ใบลา — เกินสิทธิ์"')
  const [role] = await sql`SELECT code, name, can_approve FROM platform.roles WHERE id = ${p.approver_role_id}`
  if (!role) throw new HttpError(422, 'ไม่พบบทบาทผู้อนุมัติ')
  if (!role.can_approve && !(role.code === 'admin' && p.doc_type === 'ACCOUNT'))
    throw new HttpError(422, `บทบาท "${role.name}" อนุมัติไม่ได้ (Admin ดำเนินการได้เฉพาะ "ขอเปิดบัญชีผู้ใช้")`)
  if (p.active ?? true) {
    const hi = p.max_amount ?? 'Infinity'
    const clash = await sql`
      SELECT id FROM platform.approval_policies
       WHERE doc_type = ${p.doc_type} AND step_order = ${p.step_order} AND active AND COALESCE(condition_key, '') = ${p.condition_key ?? ''}
         AND id <> COALESCE(${selfId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
         AND NOT (COALESCE(max_amount, 'Infinity'::numeric) < ${p.min_amount}::numeric OR ${hi}::numeric < min_amount) LIMIT 1`
    if (clash.length) throw new HttpError(409, 'ซ้อนกับนโยบายเดิมในขั้นเดียวกัน (วงเงินทับกัน) — ปรับช่วงวงเงินหรือลำดับขั้น')
  }
}

const Body = t.Object({
  doc_type: t.String(), min_amount: t.Number({ minimum: 0 }), max_amount: t.Optional(t.Union([t.Number({ minimum: 0 }), t.Null()])),
  step_order: t.Integer({ minimum: 1, maximum: 10 }), approver_role_id: UUID, condition_key: t.Optional(t.Union([t.String(), t.Null()])), active: t.Optional(t.Boolean()),
})

const snapshot = (p: PolicyIn & { role_code?: string }) => ({ doc_type: p.doc_type, min: p.min_amount, max: p.max_amount ?? null, step: p.step_order, role: p.role_code ?? p.approver_role_id, condition: p.condition_key ?? null, active: p.active ?? true })

export const workflowRoutes = new Elysia()
  .use(adminOnly)
  .get('/policies', async () => {
    const policies = await sql`
      SELECT p.id, p.doc_type, p.min_amount::float8 AS min_amount, p.max_amount::float8 AS max_amount, p.step_order, p.approver_role_id,
             r.code AS role_code, r.name AS role_name, p.condition_key, p.active
        FROM platform.approval_policies p JOIN platform.roles r ON r.id = p.approver_role_id ORDER BY p.doc_type, p.step_order, p.min_amount`
    const types = Object.entries(DOC_TYPES).map(([type, label]) => ({ type, label, active_steps: policies.filter((p) => p.doc_type === type && p.active).length }))
    return { types, policies }
  })
  // จำลองเส้นทางอนุมัติ ณ วงเงินที่กำหนด
  .get('/policies/preview', async ({ query }) => {
    const amount = query.amount ?? 0
    const rows = await sql`
      SELECT p.step_order, p.condition_key, r.name AS role_name FROM platform.approval_policies p JOIN platform.roles r ON r.id = p.approver_role_id
       WHERE p.doc_type = ${query.type} AND p.active AND ${amount}::numeric >= p.min_amount AND (p.max_amount IS NULL OR ${amount}::numeric <= p.max_amount) ORDER BY p.step_order`
    return rows.filter((r) => !r.condition_key || (r.condition_key === 'over_quota' && query.over_quota === 'true')).map((r) => r.role_name)
  }, { query: t.Object({ type: t.String(), amount: t.Optional(t.Numeric()), over_quota: t.Optional(t.String()) }) })

  .post('/policies', async ({ body, session, ip }) => {
    await validate(body, null)
    const id = crypto.randomUUID()
    await sql.transaction([
      sql`INSERT INTO platform.approval_policies (id, doc_type, min_amount, max_amount, step_order, approver_role_id, condition_key, active)
          VALUES (${id}, ${body.doc_type}, ${body.min_amount}, ${body.max_amount ?? null}, ${body.step_order}, ${body.approver_role_id}, ${body.condition_key ?? null}, ${body.active ?? true})`,
      audit({ session, ip }, { action: 'create_policy', table: 'platform.approval_policies', id, ref: body.doc_type, after: snapshot(body), risk: 'medium' }),
    ])
    return { id }
  }, { body: Body })

  .put('/policies/:id', async ({ params, body, session, ip }) => {
    const [old] = await sql`SELECT p.*, r.code AS role_code FROM platform.approval_policies p JOIN platform.roles r ON r.id = p.approver_role_id WHERE p.id = ${params.id}`
    if (!old) throw new HttpError(404, 'ไม่พบนโยบาย')
    await validate(body, params.id)
    await sql.transaction([
      sql`UPDATE platform.approval_policies SET doc_type = ${body.doc_type}, min_amount = ${body.min_amount}, max_amount = ${body.max_amount ?? null},
            step_order = ${body.step_order}, approver_role_id = ${body.approver_role_id}, condition_key = ${body.condition_key ?? null}, active = ${body.active ?? true} WHERE id = ${params.id}`,
      audit({ session, ip }, { action: 'update_policy', table: 'platform.approval_policies', id: params.id, ref: body.doc_type,
        before: snapshot({ ...(old as any), min_amount: Number(old.min_amount), max_amount: old.max_amount == null ? null : Number(old.max_amount) }), after: snapshot(body), risk: 'medium' }),
    ])
    return { ok: true }
  }, { params: t.Object({ id: UUID }), body: Body })

  .delete('/policies/:id', async ({ params, session, ip }) => {
    const [old] = await sql`SELECT p.doc_type, p.min_amount::float8 AS min_amount, p.max_amount::float8 AS max_amount, p.step_order, r.code AS role_code, p.condition_key, p.active
                              FROM platform.approval_policies p JOIN platform.roles r ON r.id = p.approver_role_id WHERE p.id = ${params.id}`
    if (!old) throw new HttpError(404, 'ไม่พบนโยบาย')
    await sql.transaction([
      sql`DELETE FROM platform.approval_policies WHERE id = ${params.id}`,
      audit({ session, ip }, { action: 'delete_policy', table: 'platform.approval_policies', id: params.id, ref: old.doc_type, before: old, risk: 'medium' }),
    ])
    return { ok: true }
  }, { params: t.Object({ id: UUID }) })
