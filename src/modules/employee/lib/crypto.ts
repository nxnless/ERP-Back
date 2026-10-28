/** เข้ารหัสข้อมูลลับ (เลขบัญชี) ด้วย AES-GCM — ตั้ง PII_KEY = base64 ของ 32 ไบต์  (openssl rand -base64 32) */
async function key() {
  const raw = process.env.PII_KEY
  if (!raw) throw new Error('ไม่ได้ตั้งค่า PII_KEY')
  return crypto.subtle.importKey('raw', Buffer.from(raw, 'base64'), 'AES-GCM', false, ['encrypt'])
}
/** คืนค่าเป็น hex ของ iv(12) + ciphertext เพื่อใส่ bytea ด้วย decode(..., 'hex') */
export async function encryptHex(plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(plain)))
  return Buffer.concat([iv, ct]).toString('hex')
}
