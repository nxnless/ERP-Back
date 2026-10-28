/** วันที่ปัจจุบันตามเวลาไทย (YYYY-MM-DD) — ไม่พึ่ง timezone ของ DB/เซิร์ฟเวอร์ */
export const bkkToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)

const iso = (d: Date) => d.toISOString().slice(0, 10)

/** วันที่ 1 ของเดือนที่ห่างจาก d ไป `back` เดือน (1 = เดือนก่อน, -1 = เดือนหน้า) */
export function monthStart(d: string, back = 0) {
  const [y, m] = d.split('-').map(Number)
  return iso(new Date(Date.UTC(y, m - 1 - back, 1)))
}

/** ปลายช่วง (ไม่รวม) ของ "ช่วงเดียวกันของเดือนก่อน" — เทียบ 1..วันนี้ ของเดือนนี้ กับ 1..วันเดียวกันของเดือนก่อน */
export function prevWindowEnd(d: string) {
  const ps = monthStart(d, 1), cs = monthStart(d)
  const end = iso(new Date(Date.parse(ps) + Number(d.slice(8, 10)) * 86400_000))
  return end < cs ? end : cs
}

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
/** 'YYYY-MM-DD' → '15 ต.ค. 2569' (ให้ query ส่งวันที่มาเป็น ::text เพื่อไม่ให้ timezone ทำวันเพี้ยน) */
export function thd(s?: string | null) {
  if (!s) return '—'
  const [y, m, d] = s.slice(0, 10).split('-').map(Number)
  return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`
}

export const fm = (n: number | string | null | undefined) => Number(n ?? 0).toLocaleString('th-TH', { maximumFractionDigits: 2 })
