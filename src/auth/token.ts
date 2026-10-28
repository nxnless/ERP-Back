import { SignJWT, jwtVerify } from 'jose'

const ISSUER = 'erp'
const AUDIENCE = 'erp-web'
export const TOKEN_TTL_SECONDS = Number(process.env.JWT_TTL_SECONDS ?? 8 * 3600) // ค่าเริ่มต้น 8 ชั่วโมง (1 วันทำงาน)

function secret() {
  const s = process.env.JWT_SECRET
  if (!s || s.length < 32) throw new Error('JWT_SECRET ต้องตั้งค่าและยาวอย่างน้อย 32 ตัวอักษร (openssl rand -base64 48)')
  return new TextEncoder().encode(s)
}
/** เรียกตอนเริ่มระบบเพื่อให้ล้มทันทีถ้าตั้งค่าไม่ครบ */
export const assertAuthConfig = () => void secret()

/** token พิสูจน์ "ตัวตน" เท่านั้น (sub = platform.users.id) — บทบาท/สถานะอ่านสดจากฐานข้อมูลทุก request */
export const signToken = (userId: string) =>
  new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuer(ISSUER).setAudience(AUDIENCE)
    .setIssuedAt().setExpirationTime(`${TOKEN_TTL_SECONDS}s`).sign(secret())

export async function verifyToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] })
  if (!payload.sub) throw new Error('token ไม่มี sub')
  return payload.sub
}
