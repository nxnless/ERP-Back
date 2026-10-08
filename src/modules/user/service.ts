import { status } from 'elysia'
import type { PublicUser } from './model'

type StoredUser = {
  id: string
  email: string
  name: string
  passwordHash: string
  createdAt: Date
}

// ตัวอย่างนี้เก็บใน memory เพื่อให้รันได้ทันที
// ของจริงให้เปลี่ยนเป็น Drizzle/Prisma โดยแก้เฉพาะไฟล์นี้ controller ไม่ต้องแก้
const users = new Map<string, StoredUser>()

// Service = business logic ล้วน ๆ ไม่รู้จัก Context ของ Elysia
// ใช้ abstract class + static เพราะไม่ต้องมี state ต่อ request
export abstract class UserService {
  static async create(input: { email: string; name: string; password: string }) {
    const email = input.email.toLowerCase()

    if ([...users.values()].some((u) => u.email === email)) {
      throw status(409, { message: 'Email already registered' })
    }

    const user: StoredUser = {
      id: crypto.randomUUID(),
      email,
      name: input.name,
      passwordHash: await Bun.password.hash(input.password),
      createdAt: new Date()
    }
    users.set(user.id, user)
    return user
  }

  static findByEmail(email: string) {
    return [...users.values()].find((u) => u.email === email.toLowerCase())
  }

  static getPublicById(id: string): PublicUser {
    const user = users.get(id)
    if (!user) throw status(404, { message: 'User not found' })
    return UserService.toPublic(user)
  }

  static toPublic(user: StoredUser): PublicUser {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt.toISOString()
    }
  }
}
