// ตั้ง/รีเซ็ตรหัสผ่านผู้ใช้จาก command line (ใช้สร้างรหัสให้ Admin คนแรก)
//   bun auth/scripts/set-password.ts <email> [รหัสผ่านใหม่] [--activate]
// ไม่ใส่รหัสผ่าน = สุ่มให้และแสดงครั้งเดียว · --activate = เปลี่ยนสถานะ invited → active
import { sql } from '../../shared/db'
import { hashPassword } from '../password'

const args = process.argv.slice(2)
const activate = args.includes('--activate')
const [email, given] = args.filter((a) => !a.startsWith('--'))
if (!email) { console.error('วิธีใช้: bun auth/scripts/set-password.ts <email> [รหัสผ่านใหม่] [--activate]'); process.exit(1) }

const password = given ?? Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url')
if (password.length < 10) { console.error('รหัสผ่านต้องยาวอย่างน้อย 10 ตัวอักษร'); process.exit(1) }

const rows = await sql`
  UPDATE platform.users SET password_hash = ${await hashPassword(password)}, status = CASE WHEN ${activate} THEN 'active' ELSE status END
   WHERE lower(email) = ${email.toLowerCase()} RETURNING email, status`
if (!rows.length) { console.error('ไม่พบผู้ใช้อีเมลนี้'); process.exit(1) }
console.log(`ตั้งรหัสผ่านให้ ${rows[0].email} แล้ว (สถานะ: ${rows[0].status})`)
if (!given) console.log(`รหัสผ่านชั่วคราว (แสดงครั้งเดียว): ${password}`)
process.exit(0)
