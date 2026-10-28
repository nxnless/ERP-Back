import { describe, expect, it } from 'bun:test'
import { app } from '../src/app'

// เทสต์ผ่าน app.handle() ไม่ต้องเปิด server จริง
const post = (path: string, body: unknown) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  )

describe('auth + user flow', () => {
  const credentials = { email: 'a@example.com', name: 'Alice', password: 'password123' }
  let token = ''

  it('sign up ได้ token', async () => {
    const res = await post('/auth/sign-up', credentials)
    expect(res.status).toBe(200)
    token = (await res.json()).token
    expect(token).toBeString()
  })

  it('sign up อีเมลซ้ำได้ 409', async () => {
    const res = await post('/auth/sign-up', credentials)
    expect(res.status).toBe(409)
  })

  it('รหัสผ่านสั้นไป ได้ 422', async () => {
    const res = await post('/auth/sign-up', { ...credentials, email: 'b@example.com', password: '123' })
    expect(res.status).toBe(422)
  })

  it('sign in รหัสผิด ได้ 401', async () => {
    const res = await post('/auth/sign-in', { email: credentials.email, password: 'wrong-password' })
    expect(res.status).toBe(401)
  })

  it('/users/me ไม่มี token ได้ 401', async () => {
    const res = await app.handle(new Request('http://localhost/users/me'))
    expect(res.status).toBe(401)
  })

  it('/users/me มี token ได้ข้อมูลตัวเอง', async () => {
    const res = await app.handle(
      new Request('http://localhost/users/me', { headers: { authorization: `Bearer ${token}` } })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).email).toBe(credentials.email)
  })
})
