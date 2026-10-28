import { HttpError } from '../../../shared/errors'

export type EtaxInvoice = { id: string; doc_no: string; party_name: string; party_tax_id: string | null; total: number }
/** ผลจากผู้ให้บริการ e-Tax: สำเร็จ { ref } หรือถูกปฏิเสธ { rejected: เหตุผล } */
export type EtaxResult = { ref: string } | { rejected: string }
export type EtaxProvider = (inv: EtaxInvoice) => Promise<EtaxResult>

/**
 * จุดเชื่อมต่อผู้ให้บริการ e-Tax Invoice / กรมสรรพากร — ยังไม่ได้เชื่อมต่อจริง (ต้องเลือกผู้ให้บริการ + มีใบรับรองดิจิทัล)
 * ค่าเริ่มต้นจึงปฏิเสธด้วย 501 เพื่อไม่ให้สถานะ "ส่งแล้ว" ปลอม — เรียก setEtaxProvider(fn) ตอนเริ่มระบบเมื่อมีผู้ให้บริการ
 */
let provider: EtaxProvider = async () => { throw new HttpError(501, 'ยังไม่ได้เชื่อมต่อผู้ให้บริการ e-Tax Invoice') }
export const setEtaxProvider = (p: EtaxProvider) => { provider = p }
export const submitEtax: EtaxProvider = (inv) => provider(inv)
