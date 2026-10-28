import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { adminOnly } from '../guard'
import { audit } from '../lib/audit'
import { UUID } from '../lib/rules'

// ตารางที่มีคอลัมน์ custom jsonb รองรับฟิลด์เพิ่มเติม
export const ENTITIES: Record<string, string> = {
  'purchasing.purchase_orders': 'ใบสั่งซื้อ', 'sales.quotations': 'ใบเสนอราคา', 'sales.sales_orders': 'ใบสั่งขาย', 'master.items': 'สินค้า',
}
// เอกสารที่มีเทมเพลตพิมพ์
export const TEMPLATE_TYPES: Record<string, string> = {
  QT: 'ใบเสนอราคา', SO: 'ใบสั่งขาย', DN: 'ใบส่งของ', INV: 'ใบแจ้งหนี้', RC: 'ใบเสร็จรับเงิน', PO: 'ใบสั่งซื้อ', GRN: 'ใบรับสินค้า', PV: 'ใบสำคัญจ่าย', LV: 'ใบลา',
}
const MAX_BODY = 100_000

export const formRoutes = new Elysia()
  .use(adminOnly)
  // ---------- ฟิลด์เพิ่มเติม (Custom Field / Form Builder) ----------
  .get('/fields', async ({ query }) => ({
    entities: Object.entries(ENTITIES).map(([value, label]) => ({ value, label })),
    fields: await sql`SELECT id, entity, key, label, field_type, required, options, sort_order, active FROM platform.custom_field_definitions
                       WHERE (${query.entity ?? null}::text IS NULL OR entity = ${query.entity ?? null}) ORDER BY entity, sort_order, key`,
  }), { query: t.Object({ entity: t.Optional(t.String()) }) })

  .post('/fields', async ({ body, session, ip }) => {
    if (!ENTITIES[body.entity]) throw new HttpError(422, 'ไม่รองรับฟอร์มนี้')
    if (body.field_type === 'select' && !body.options?.length) throw new HttpError(422, 'ชนิดรายการเลือกต้องมีตัวเลือกอย่างน้อย 1 ค่า')
    if ((await sql`SELECT 1 FROM platform.custom_field_definitions WHERE entity = ${body.entity} AND key = ${body.key}`).length) throw new HttpError(409, 'รหัสฟิลด์นี้มีอยู่แล้วในฟอร์มนี้')
    const id = crypto.randomUUID()
    const opts = body.field_type === 'select' ? JSON.stringify(body.options) : null
    await sql.transaction([
      sql`INSERT INTO platform.custom_field_definitions (id, entity, key, label, field_type, required, options, sort_order)
          VALUES (${id}, ${body.entity}, ${body.key}, ${body.label.trim()}, ${body.field_type}, ${body.required ?? false}, ${opts}::jsonb, ${body.sort_order ?? 0})`,
      audit({ session, ip }, { action: 'create_field', table: 'platform.custom_field_definitions', id, ref: `${body.entity}.${body.key}`, after: { label: body.label, type: body.field_type, required: body.required ?? false } }),
    ])
    return { id }
  }, { body: t.Object({
      entity: t.String(), key: t.String({ pattern: '^[a-z][a-z0-9_]{1,40}$' }), label: t.String({ minLength: 1, maxLength: 80 }),
      field_type: t.Union([t.Literal('text'), t.Literal('number'), t.Literal('date'), t.Literal('select'), t.Literal('file')]),
      required: t.Optional(t.Boolean()), options: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 60 }), { maxItems: 50 })), sort_order: t.Optional(t.Integer({ minimum: 0, maximum: 999 })),
  }) })

  // แก้ได้เฉพาะชื่อที่แสดง/บังคับกรอก/ตัวเลือก/ลำดับ/เปิดปิด — รหัสและชนิดคงที่ เพื่อไม่ให้ข้อมูลเก่าใน jsonb เพี้ยน (ไม่มีลบ ให้ปิดใช้แทน)
  .put('/fields/:id', async ({ params, body, session, ip }) => {
    const [f] = await sql`SELECT * FROM platform.custom_field_definitions WHERE id = ${params.id}`
    if (!f) throw new HttpError(404, 'ไม่พบฟิลด์')
    if (f.field_type === 'select' && !body.options?.length) throw new HttpError(422, 'ชนิดรายการเลือกต้องมีตัวเลือกอย่างน้อย 1 ค่า')
    const opts = f.field_type === 'select' ? JSON.stringify(body.options) : null
    await sql.transaction([
      sql`UPDATE platform.custom_field_definitions SET label = ${body.label.trim()}, required = ${body.required}, options = ${opts}::jsonb, sort_order = ${body.sort_order}, active = ${body.active} WHERE id = ${params.id}`,
      audit({ session, ip }, { action: 'update_field', table: 'platform.custom_field_definitions', id: params.id, ref: `${f.entity}.${f.key}`,
        before: { label: f.label, required: f.required, options: f.options, sort_order: f.sort_order, active: f.active }, after: body }),
    ])
    return { ok: true }
  }, { params: t.Object({ id: UUID }), body: t.Object({ label: t.String({ minLength: 1, maxLength: 80 }), required: t.Boolean(), options: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 60 }), { maxItems: 50 })), sort_order: t.Integer({ minimum: 0, maximum: 999 }), active: t.Boolean() }) })

  // ---------- เทมเพลตเอกสาร ----------
  .get('/templates', async () => ({
    types: Object.entries(TEMPLATE_TYPES).map(([value, label]) => ({ value, label })),
    templates: await sql`SELECT id, doc_type, version, published_at, published_by, length(body) AS size FROM platform.document_templates ORDER BY doc_type, version DESC`,
  }))
  .get('/templates/:id', async ({ params }) => {
    const [row] = await sql`SELECT id, doc_type, version, body, published_at FROM platform.document_templates WHERE id = ${params.id}`
    if (!row) throw new HttpError(404, 'ไม่พบเทมเพลต')
    return row
  }, { params: t.Object({ id: UUID }) })
  // สร้างเวอร์ชันใหม่ (ร่าง) — คัดลอกจากเวอร์ชันล่าสุดของประเภทนั้นถ้ามี
  .post('/templates', async ({ body, session, ip }) => {
    if (!TEMPLATE_TYPES[body.doc_type]) throw new HttpError(422, 'ประเภทเอกสารไม่ถูกต้อง')
    const [last] = await sql`SELECT version, body FROM platform.document_templates WHERE doc_type = ${body.doc_type} ORDER BY version DESC LIMIT 1`
    if (last && !(await sql`SELECT 1 FROM platform.document_templates WHERE doc_type = ${body.doc_type} AND published_at IS NOT NULL AND version = ${last.version}`).length)
      throw new HttpError(409, 'มีเวอร์ชันร่างค้างอยู่ — เผยแพร่หรือลบร่างก่อนสร้างเวอร์ชันใหม่')
    const id = crypto.randomUUID(), version = (last?.version ?? 0) + 1, text = body.body ?? last?.body ?? '<h1>{{doc_no}}</h1>\n<p>{{party_name}}</p>\n<p>รวมทั้งสิ้น {{total}} บาท</p>'
    await sql.transaction([
      sql`INSERT INTO platform.document_templates (id, doc_type, version, body) VALUES (${id}, ${body.doc_type}, ${version}, ${text})`,
      audit({ session, ip }, { action: 'create_template', table: 'platform.document_templates', id, ref: `${body.doc_type} v${version}` }),
    ])
    return { id, version }
  }, { body: t.Object({ doc_type: t.String(), body: t.Optional(t.String({ maxLength: MAX_BODY })) }) })
  .put('/templates/:id', async ({ params, body, session, ip }) => {
    const [row] = await sql`SELECT doc_type, version, published_at FROM platform.document_templates WHERE id = ${params.id}`
    if (!row) throw new HttpError(404, 'ไม่พบเทมเพลต')
    if (row.published_at) throw new HttpError(409, 'เวอร์ชันที่เผยแพร่แล้วแก้ไม่ได้ — สร้างเวอร์ชันใหม่แทน')
    await sql.transaction([
      sql`UPDATE platform.document_templates SET body = ${body.body} WHERE id = ${params.id}`,
      audit({ session, ip }, { action: 'update_template', table: 'platform.document_templates', id: params.id, ref: `${row.doc_type} v${row.version}` }),
    ])
    return { ok: true }
  }, { params: t.Object({ id: UUID }), body: t.Object({ body: t.String({ minLength: 1, maxLength: MAX_BODY }) }) })
  .post('/templates/:id/publish', async ({ params, session, ip }) => {
    const [row] = await sql`SELECT doc_type, version, published_at FROM platform.document_templates WHERE id = ${params.id}`
    if (!row) throw new HttpError(404, 'ไม่พบเทมเพลต')
    if (row.published_at) throw new HttpError(409, 'เผยแพร่ไปแล้ว')
    await sql.transaction([
      sql`UPDATE platform.document_templates SET published_at = now(), published_by = ${session.userId} WHERE id = ${params.id}`,
      audit({ session, ip }, { action: 'publish_template', table: 'platform.document_templates', id: params.id, ref: `${row.doc_type} v${row.version}`, risk: 'medium' }),
    ])
    return { ok: true }
  }, { params: t.Object({ id: UUID }) })
  .delete('/templates/:id', async ({ params, session, ip }) => {
    const [row] = await sql`SELECT doc_type, version, published_at FROM platform.document_templates WHERE id = ${params.id}`
    if (!row) throw new HttpError(404, 'ไม่พบเทมเพลต')
    if (row.published_at) throw new HttpError(409, 'ลบเวอร์ชันที่เผยแพร่แล้วไม่ได้')
    await sql.transaction([
      sql`DELETE FROM platform.document_templates WHERE id = ${params.id}`,
      audit({ session, ip }, { action: 'delete_template_draft', table: 'platform.document_templates', id: params.id, ref: `${row.doc_type} v${row.version}` }),
    ])
    return { ok: true }
  }, { params: t.Object({ id: UUID }) })
