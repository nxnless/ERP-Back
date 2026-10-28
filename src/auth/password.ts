// ใช้ argon2id ที่มากับ Bun (Bun.password) — ถ้าใช้ Node ให้เปลี่ยนเป็น @node-rs/argon2 ในไฟล์นี้ไฟล์เดียว
export const hashPassword = (plain: string) => Bun.password.hash(plain, { algorithm: 'argon2id' })

export async function verifyPassword(plain: string, hash: string) {
  try { return await Bun.password.verify(plain, hash) } catch { return false } // hash รูปแบบผิด = ไม่ผ่าน
}

// กัน "เดาว่าอีเมลมีในระบบไหม" จากเวลาตอบ: ถ้าไม่พบผู้ใช้ก็ verify กับ hash หลอกให้ใช้เวลาเท่ากัน
let decoy: Promise<string> | undefined
export async function burnVerify(plain: string) {
  decoy ??= hashPassword('decoy-never-matches-' + crypto.randomUUID())
  await verifyPassword(plain, await decoy)
}
