/**
 * จุดต่อผู้ให้บริการรับชำระเงินออนไลน์ (PromptPay QR / บัตรเครดิต) — ยังไม่ได้ต่อ
 * คืน null = ช่องทางนี้ยังไม่เปิดให้บริการ (เส้นทาง POST /portal/payments จะตอบ 503 และหน้าจอไม่แสดงช่องทางนั้น)
 * เมื่อต่อจริง: สร้างรายการกับผู้ให้บริการ แล้วคืน { providerRef, payload } (payload เช่น QR/URL ชำระบัตร)
 * และให้ webhook ของผู้ให้บริการเป็นผู้เปลี่ยน portal.online_payments เป็น paid + ให้ฝ่ายบัญชีออกใบเสร็จ
 */
export type Charge = { providerRef: string; payload: Record<string, unknown> }
export const gatewayEnabled = (_method: 'promptpay' | 'card') => false
export async function startCharge(_method: 'promptpay' | 'card', _amount: number, _ref: string): Promise<Charge | null> {
  return null
}
