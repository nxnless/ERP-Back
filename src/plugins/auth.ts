import { Elysia } from 'elysia'
import { jwt } from '@elysiajs/jwt'
import { env } from '../config/env'

// Plugin ที่ตั้ง name ไว้ → Elysia จะ deduplicate ไม่โหลดซ้ำแม้ถูก .use() หลายที่
// 1) ลง jwt plugin  2) ประกาศ macro "isAuth" ไว้ใช้ใน route
// route ไหนใส่ { isAuth: true } จะได้ userId ใน context และถ้า token ผิดจะได้ 401 ทันที
export const authPlugin = new Elysia({ name: 'plugin.auth' })
  .use(jwt({ name: 'jwt', secret: env.JWT_SECRET, exp: '7d' }))
  .macro({
    isAuth: {
      async resolve({ jwt, headers, status }) {
        const token = headers.authorization?.replace('Bearer ', '')
        const payload = token ? await jwt.verify(token) : false

        if (!payload || !payload.sub) {
          return status(401, { message: 'Unauthorized' })
        }

        return { userId: payload.sub }
      }
    }
  })
