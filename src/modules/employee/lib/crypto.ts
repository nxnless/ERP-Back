/** เข้ารหัสข้อมูลลับ (เลขบัญชี) ด้วย AES-GCM — รองรับทั้ง raw 32 bytes หรือ base64 */
async function key() {
  const raw = process.env.PII_KEY ?? 'OpenSSLKey123456789012345678901234567890'
  // แปลงให้เป็น 32 bytes แน่นอน
  const buf = Buffer.alloc(32)
  const source = Buffer.from(raw)
  source.copy(buf)
  return crypto.subtle.importKey('raw', buf, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** คืนค่าเป็น hex ของ iv(12) + ciphertext เพื่อใส่ bytea ด้วย decode(..., 'hex') */
export async function encryptHex(plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(plain)))
  return Buffer.concat([iv, ct]).toString('hex')
}
