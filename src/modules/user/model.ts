import { t } from 'elysia'

// Model = schema ของ module นี้ (ใช้ทั้ง validate, สร้าง type, และสร้างเอกสาร OpenAPI)
export const UserModel = {
  public: t.Object({
    id: t.String(),
    email: t.String(),
    name: t.String(),
    roles: t.Array(t.String()),
    createdAt: t.String()
  }),
  params: t.Object({ id: t.String() })
}

// ดึง type ออกจาก schema → เขียน schema ที่เดียว ไม่ต้องเขียน interface ซ้ำ
export type PublicUser = typeof UserModel.public.static
