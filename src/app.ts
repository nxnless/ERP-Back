import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { openapi } from '@elysiajs/openapi'
import { errorPlugin } from './plugins/error'
import { auth } from './modules/auth'
import { user } from './modules/user'

// ประกอบ app จาก plugin/module ด้วย method chaining (เพื่อให้ type ไม่หาย)
// แยกจาก index.ts เพื่อให้เทสต์ import app ได้โดยไม่ต้องเปิด server
export const app = new Elysia()
  .use(cors())
  .use(openapi()) // เอกสาร API ที่ /openapi
  .use(errorPlugin)
  .get('/health', () => ({ status: 'ok' }))
  .use(auth)
  .use(user)

// export type ไปให้ frontend ใช้กับ Eden Treaty: treaty<App>('localhost:3000')
export type App = typeof app
