import { Elysia } from 'elysia'
import { authenticated } from '../../auth/plugin'
import { sql } from '../../shared/db'
import { HttpError } from '../../shared/errors'

const ipOf = (h: Record<string, string | undefined>) => {
  const v = (h['x-forwarded-for']?.split(',')[0] ?? h['x-real-ip'] ?? '').trim()
  return /^[0-9a-fA-F:.]{3,45}$/.test(v) ? v : null
}

/**
 * ด่านของ Portal (ผู้ใช้ภายนอก) — ข้อสมมติ: ตอนล็อกอินพอร์ทัล ระบบออก session ที่ userId = portal.portal_users.id และ roles = ['portal']
 * (การล็อกอิน/รหัสผ่าน/2FA ของพอร์ทัลอยู่นอกโมดูลนี้ — ดู PATCHES.md ข้อ 1)
 *
 * ทุก route ได้ `me` = { id, partyId, name, email, partyName, partyCode, kinds }
 *  - partyId มาจากตาราง portal_users เสมอ **ห้ามรับจาก request** — ทุก query ต้องกรองด้วย me.partyId
 *  - kinds = ['customer'] | ['supplier'] | ทั้งสอง ตาม master.party_roles
 */
export const portalOnly = new Elysia({ name: 'portal/guard' })
  .use(authenticated)
  .onBeforeHandle(({ session }) => {
    if (!session.roles.includes('portal')) throw new HttpError(403, 'เฉพาะผู้ใช้พอร์ทัลเท่านั้น')
  })
  .derive(async ({ headers, session }) => {
    const [u] = await sql`
      SELECT u.id, u.party_id, u.display_name, u.email, u.mfa_enabled, u.status, p.name AS party_name, p.code AS party_code,
             COALESCE((SELECT array_agg(r.role ORDER BY r.role) FROM master.party_roles r WHERE r.party_id = u.party_id), '{}') AS kinds
        FROM portal.portal_users u JOIN master.parties p ON p.id = u.party_id
       WHERE u.id = ${session.userId}`
    if (!u || u.status !== 'active') throw new HttpError(403, 'บัญชีพอร์ทัลนี้ไม่ได้อยู่ในสถานะใช้งาน')
    return {
      ip: ipOf(headers),
      me: { id: u.id as string, partyId: u.party_id as string, name: u.display_name as string, email: u.email as string, mfa: u.mfa_enabled as boolean,
            partyName: u.party_name as string, partyCode: u.party_code as string, kinds: u.kinds as string[] },
    }
  })
  .as('scoped')

/** จำกัดเฉพาะผู้ใช้ที่ฝ่ายของตนเป็นลูกค้า / ซัพพลายเออร์ */
export const kindOnly = (kind: 'customer' | 'supplier') =>
  new Elysia({ name: `portal/kind/${kind}` })
    .use(portalOnly)
    .onBeforeHandle(({ me }) => {
      if (!me.kinds.includes(kind)) throw new HttpError(403, kind === 'customer' ? 'เมนูนี้สำหรับลูกค้าเท่านั้น' : 'เมนูนี้สำหรับซัพพลายเออร์เท่านั้น')
    })
    .as('scoped')
