// รวมการอ่าน environment variable ไว้ที่เดียว และ fail ทันทีถ้าค่าที่จำเป็นหายไป
// (Bun โหลดไฟล์ .env ให้อัตโนมัติ ไม่ต้องใช้ dotenv)
const JWT_SECRET = process.env.JWT_SECRET

if (!JWT_SECRET) {
  throw new Error('Missing env: JWT_SECRET (copy .env.example to .env)')
}

export const env = {
  PORT: Number(process.env.PORT ?? 3000),
  JWT_SECRET
}
