import { Elysia } from 'elysia'
import { authPlugin } from '../../plugins/auth'
import { ErrorModel } from '../../shared/model'
import { UserModel } from './model'
import { UserService } from './service'

// Controller = Elysia instance 1 ตัว ต่อ 1 module
// หน้าที่: กำหนด route, ผูก schema, เรียก service เท่านั้น (ไม่ใส่ logic หนัก ๆ ที่นี่)
export const user = new Elysia({ prefix: '/users', name: 'module.user' })
  .use(authPlugin)
  .get('/me', ({ userId }) => UserService.getPublicById(userId), {
    isAuth: true, // macro จาก authPlugin → ได้ userId หรือ 401
    response: { 200: UserModel.public, 401: ErrorModel, 404: ErrorModel },
    detail: { tags: ['User'], summary: 'Get current user' }
  })
  .get('/:id', ({ params: { id } }) => UserService.getPublicById(id), {
    params: UserModel.params,
    response: { 200: UserModel.public, 404: ErrorModel },
    detail: { tags: ['User'], summary: 'Get user by id' }
  })
