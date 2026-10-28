import { status } from 'elysia'
import { UserService } from '../user/service'
import type { SignInBody, SignUpBody } from './model'

export abstract class AuthService {
  static signUp(body: SignUpBody) {
    return UserService.create(body)
  }

  static async signIn({ email, password }: SignInBody) {
    const user = UserService.findByEmail(email)

    // ตอบข้อความเดียวกันทั้งกรณีไม่เจอ user และรหัสผิด เพื่อไม่เปิดเผยว่ามีอีเมลนี้ในระบบ
    if (!user || !(await Bun.password.verify(password, user.passwordHash))) {
      throw status(401, { message: 'Invalid email or password' })
    }

    return user
  }
}
