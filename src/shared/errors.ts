export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

/** ตัวจัดการ error กลาง: .onError({ as: 'global' }, errorHandler) */
export const errorHandler = ({ code, error, set }: { code: string | number; error: unknown; set: { status?: number | string } }) => {
  if (error instanceof HttpError) {
    set.status = error.status
    return { error: error.message }
  }
  if (code === 'VALIDATION') {
    set.status = 422
    return { error: 'ข้อมูลที่กรอกไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง' }
  }
  if (code === 'NOT_FOUND') {
    set.status = 404
    return { error: 'ไม่พบข้อมูล' }
  }
  console.error(`[${String(code)}]`, error)
  set.status = 500
  return { error: 'เกิดข้อผิดพลาดภายในระบบ' }
}
