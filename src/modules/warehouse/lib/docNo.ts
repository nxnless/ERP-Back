import { sql } from '../../../shared/db'

/**
 * เลขเอกสาร: PREFIX-<ปี พ.ศ.>-<ลำดับ 4 หลัก> เช่น GRN-2569-0318
 * ถ้าโปรเจคหลักมีตัวสร้างเลขเอกสารกลางอยู่แล้ว ให้แก้ nextDocNo() ให้เรียกตัวนั้นแทน (ที่เดียวพอ)
 */
const KINDS = {
  GRN: ['inventory.goods_receipts', 'doc_no'],
  TRF: ['inventory.stock_transfers', 'doc_no'],
  CNT: ['inventory.stock_counts', 'doc_no'],
  REQ: ['platform.requests', 'request_no'],
} as const
export type DocKind = keyof typeof KINDS

export async function nextDocNo(kind: DocKind) {
  const [table, col] = KINDS[kind]
  const prefix = `${kind}-${new Date().getFullYear() + 543}-`
  const r = await sql.query(`SELECT COALESCE(max(substring(${col} from '[0-9]+$')::int), 0) + 1 AS n FROM ${table} WHERE ${col} LIKE $1`, [prefix + '%'])
  return prefix + String(r[0].n).padStart(4, '0')
}

/** สร้างเลขแล้วรัน run(เลข) — ถ้าเลขชนกับคนอื่นที่บันทึกพร้อมกัน (unique violation) จะขอเลขใหม่แล้วลองซ้ำ */
export async function withDocNo<T>(kind: DocKind, run: (docNo: string) => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    const docNo = await nextDocNo(kind)
    try {
      return await run(docNo)
    } catch (e: any) {
      if (e?.code === '23505' && i < 4) continue
      throw e
    }
  }
}
