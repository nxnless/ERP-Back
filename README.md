# Elysia Best Practice Starter

โปรเจกต์ตัวอย่างที่จัดตามแนวทาง Best Practice ของ Elysia
(1 Elysia instance = 1 controller, แยก service/model, ใช้ plugin + macro, error handling กลาง, เทสต์ด้วย `app.handle()`)

## เริ่มใช้งาน

```bash
bun install
cp .env.example .env     # แก้ JWT_SECRET ให้เป็นค่าสุ่มยาว ๆ
bun dev                  # http://localhost:3000  | เอกสาร API: /openapi
bun test
bun run typecheck
```

ลองยิง:

```bash
curl -X POST localhost:3000/auth/sign-up -H 'content-type: application/json' \
  -d '{"email":"a@example.com","name":"Alice","password":"password123"}'

curl localhost:3000/users/me -H 'authorization: Bearer <token>'
```

## แต่ละไฟล์เขียนอะไร

| ไฟล์ | หน้าที่ |
|---|---|
| `src/index.ts` | Entry point เปิด server อย่างเดียว |
| `src/app.ts` | ประกอบ app (cors, openapi, error plugin, modules) และ `export type App` ให้ Eden Treaty ใช้ แยกจาก index เพื่อให้เทสต์ import ได้โดยไม่เปิด port |
| `src/config/env.ts` | อ่าน env ที่เดียว ถ้าค่าที่จำเป็นหายจะ fail ตั้งแต่เริ่ม |
| `src/plugins/error.ts` | `onError` แบบ global จัดรูปแบบ error ทั้งแอป (422 validation, 404, 500) |
| `src/plugins/auth.ts` | ลง JWT plugin และประกาศ macro `isAuth` ใช้ใน route ด้วย `{ isAuth: true }` |
| `src/shared/model.ts` | schema ที่หลาย module ใช้ร่วมกัน (เช่น ErrorModel) |
| `src/modules/<name>/index.ts` | **Controller**: Elysia instance กำหนด route + schema แล้วเรียก service |
| `src/modules/<name>/service.ts` | **Service**: business logic ล้วน ไม่รู้จัก Context ของ Elysia |
| `src/modules/<name>/model.ts` | **Model**: schema ด้วย TypeBox (`t`) และ type ที่ดึงจาก schema |
| `tests/setup.ts` | ตั้ง env สำหรับเทสต์ (preload ผ่าน `bunfig.toml`) |
| `tests/auth.test.ts` | เทสต์ flow sign-up → sign-in → /users/me ผ่าน `app.handle()` |
| `bunfig.toml` | ตั้งให้ `bun test` โหลด `tests/setup.ts` ก่อน |
| `tsconfig.json` | ตั้งค่า TypeScript แบบ strict สำหรับ Bun |
| `Dockerfile` | Build image สำหรับ deploy |
| `.env.example` | ตัวอย่าง environment variable |

## ถ้าจะทำต่อ

1. **เพิ่ม module ใหม่**: คัดลอกโฟลเดอร์ `modules/user` เป็นชื่อใหม่ แล้ว `.use()` ใน `src/app.ts`
2. **ต่อฐานข้อมูลจริง**: ตอนนี้ `user/service.ts` เก็บใน memory ให้เปลี่ยนเป็น Drizzle ORM (ใช้ `drizzle-typebox` แปลง table เป็น TypeBox เพื่อไม่ต้องเขียน model ซ้ำ) โดยแก้เฉพาะ service
3. **Frontend**: `bun add @elysiajs/eden` แล้วใช้ `treaty<App>('localhost:3000')` เพื่อเรียก API แบบมี type ครบ
4. **Deploy**: `bun run build` ได้ binary เดียว (`./server`) หรือใช้ Dockerfile

> หมายเหตุ: API ของ Elysia เปลี่ยนเร็ว ถ้าอัปเดตเวอร์ชันแล้วมีปัญหา ให้เทียบกับ https://elysiajs.com/llms.txt
