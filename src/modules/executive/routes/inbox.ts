import { Elysia, t } from 'elysia'
import { executiveOnly } from '../guard'
import { decide } from '../lib/decide'
import { loadInbox } from '../lib/describe'
import { UUID } from '../lib/rules'

export const inboxRoutes = new Elysia()
  .use(executiveOnly)
  // รายการที่รอผู้บริหารอนุมัติ พร้อมรายละเอียด/รายการตรวจสอบ (ผู้ยื่นเป็นตัวเองจะไม่ขึ้น)
  .get('/inbox', async ({ session }) => await loadInbox(session.userId))

  // อนุมัติ/ไม่อนุมัติขั้นของผู้บริหาร (ไม่อนุมัติต้องมีเหตุผล) — คำขอที่ยังมีขั้นถัดไปจะส่งต่อ, ขั้นสุดท้ายจะอัปเดตเอกสารต้นทาง
  .post('/inbox/:id/decision', async ({ params, body, session, ip }) => await decide({ session, ip }, params.id, body.action, body.comment),
    { params: t.Object({ id: UUID }), body: t.Object({ action: t.Union([t.Literal('approve'), t.Literal('reject')]), comment: t.Optional(t.String({ maxLength: 300 })) }) })
