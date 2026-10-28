-- ตารางเพิ่มเติม 1 ตาราง (ไม่มีใน erp_tables.sql) — รัน "ก่อน" ใช้ Dashboard/รายงาน (รันซ้ำได้)
-- เป้ายอดขายรายเดือน: department_id ว่าง = เป้าทั้งสาขา, มีค่า = เป้าของทีม (ใช้แผนก master.departments เป็นทีม)
CREATE TABLE IF NOT EXISTS sales.sales_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES platform.branches,
  department_id uuid REFERENCES master.departments,
  period date NOT NULL CHECK (extract(day FROM period) = 1),        -- เดือนของเป้า (วันที่ 1)
  amount numeric(18,2) NOT NULL CHECK (amount >= 0),                -- ยอดขายก่อน VAT
  UNIQUE NULLS NOT DISTINCT (branch_id, department_id, period)      -- ต้องใช้ PostgreSQL 15+
);
