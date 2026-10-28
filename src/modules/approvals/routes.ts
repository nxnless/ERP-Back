import { Elysia, t } from 'elysia'
import { decide } from './lib/decide'
import { loadInbox } from './lib/describe'
import { ROLE_TYPES, UUID } from './lib/rules'

/**
 * กล่องอนุมัติสำหรับ "ขั้นที่ผู้อนุมัติเป็นบทบาทใน roles" — ใช้ซ้ำได้ทุกบทบาท
 *   .use(approvalRoutes(executiveOnly, 'executive'))
 *   .use(approvalRoutes(purchasingApprover, ['purchasing_head', 'dept_head']))
 * guard = ด่านตรวจสิทธิ์ของโมดูลนั้น (ต้องให้ session และ ip) · ทุกบทบาทต้องมีใน ROLE_TYPES (lib/rules.ts)
 * ผู้ใช้เห็น/อนุมัติเฉพาะขั้นของบทบาทที่ตนถือจริง (ตัดจาก session.roles) — บทบาทกำหนดที่โค้ดนี้ ไม่รับจากผู้ใช้
 */
export function approvalRoutes(guard: any, roles: string | string[]) {
  const all = Array.isArray(roles) ? roles : [roles]
  for (const r of all) if (!ROLE_TYPES[r]) throw new Error(`approvals: ยังไม่ได้กำหนดประเภทคำขอของบทบาท "${r}" ใน ROLE_TYPES`)
  const mine = (session: any) => all.filter((r) => session.roles.includes(r))
  return new Elysia()
    .use(guard)
    // รายการที่รอบทบาทของผู้ใช้อนุมัติ พร้อมรายละเอียด/เช็กลิสต์ (ผู้ยื่นเป็นตัวเองจะไม่ขึ้น)
    .get('/inbox', async ({ session }: any) => await loadInbox(session.userId, mine(session)))
    // อนุมัติ/ไม่อนุมัติ (ไม่อนุมัติต้องมีเหตุผล) — ยังมีขั้นถัดไปจะส่งต่อ, ขั้นสุดท้ายจะอัปเดตเอกสารต้นทาง
    .post('/inbox/:id/decision', async ({ params, body, session, ip }: any) => await decide({ session, ip }, mine(session), params.id, body.action, body.comment),
      { params: t.Object({ id: UUID }), body: t.Object({ action: t.Union([t.Literal('approve'), t.Literal('reject')]), comment: t.Optional(t.String({ maxLength: 300 })) }) })
}
