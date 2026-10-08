import { t } from 'elysia'

// schema ที่หลาย module ใช้ร่วมกัน เช่น รูปแบบ error response
export const ErrorModel = t.Object({
  message: t.String()
})
