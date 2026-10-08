import { Elysia } from 'elysia'

// จัดการ error ทั้งแอปที่เดียว ให้ response หน้าตาเหมือนกันเสมอ
// as: 'global' ทำให้ hook นี้มีผลกับทุก instance ที่ .use(errorPlugin)
// ถ้า return ค่าอะไรกลับ = ใช้ค่านั้นตอบ, ถ้าไม่ return = ให้ Elysia จัดการตามปกติ
export const errorPlugin = new Elysia({ name: 'plugin.error' }).onError(
  { as: 'global' },
  ({ code, error, set }) => {
    if (code === 'VALIDATION') {
      set.status = 422
      return { message: 'Validation failed', details: error.all }
    }

    if (code === 'NOT_FOUND') {
      set.status = 404
      return { message: 'Route not found' }
    }

    if (code === 'INTERNAL_SERVER_ERROR' || code === 'UNKNOWN') {
      console.error(error)
      set.status = 500
      return { message: 'Internal server error' }
    }
  }
)
