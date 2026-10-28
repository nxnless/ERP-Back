import { neon } from '@neondatabase/serverless'

if (!process.env.DATABASE_URL) throw new Error('ไม่ได้ตั้งค่า DATABASE_URL')

/** Neon HTTP driver: sql`...` ทีละคำสั่ง, sql.transaction([...]) สำหรับหลายคำสั่งแบบ atomic */
export const sql = neon(process.env.DATABASE_URL)
