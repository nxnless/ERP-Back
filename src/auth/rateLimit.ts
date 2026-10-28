// จำกัดการเดารหัสผ่าน (ในหน่วยความจำของ process เดียว — ถ้ารันหลายเครื่องให้ย้ายไป Redis/ตาราง)
const WINDOW_MS = 15 * 60_000
const hits = new Map<string, number[]>()

const recent = (key: string) => {
  const now = Date.now()
  const list = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS)
  list.length ? hits.set(key, list) : hits.delete(key)
  return list
}
export const isLimited = (key: string, max: number) => recent(key).length >= max
export const recordFail = (key: string) => hits.set(key, [...recent(key), Date.now()])
export const clearFails = (key: string) => hits.delete(key)

setInterval(() => { for (const k of [...hits.keys()]) recent(k) }, WINDOW_MS).unref?.()
