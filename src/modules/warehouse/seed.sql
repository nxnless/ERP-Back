-- ข้อมูลอ้างอิงที่โมดูลคลังสินค้าต้องใช้ (รันซ้ำได้ ไม่ทับของเดิม) — ต้องรัน backend/admin/seed.sql ก่อน (บทบาท/โมดูล)

-- สิทธิ์โมดูล "คลังสินค้า" ของบทบาท warehouse (Admin ปรับได้ที่หน้า บทบาทและสิทธิ์)
INSERT INTO platform.role_module_access (role_id, module_code, level)
SELECT r.id, 'inventory', 'write' FROM platform.roles r WHERE r.code = 'warehouse'
ON CONFLICT (role_id, module_code) DO NOTHING;

-- คลังตัวอย่าง (ข้ามได้ถ้ามีคลังอยู่แล้ว)
INSERT INTO master.warehouses (code, name) VALUES ('WH-MAIN', 'คลังหลัก'), ('WH-BR1', 'คลังสาขา 1')
ON CONFLICT (code) DO NOTHING;

-- นโยบายอนุมัติเริ่มต้น (ขั้นเดียว) ถ้ายังไม่มี — ไม่มีนโยบาย = ส่งผลตรวจนับ/ยื่นคำขอเบิกไม่ได้
--   COUNT_ADJUST: ผู้จัดการอนุมัติการปรับยอดจากผลตรวจนับ (คลังยื่นด้วยมูลค่า 0 จึงต้องมีช่วงวงเงินที่เริ่มจาก 0)
--   ISSUE: หัวหน้าแผนกอนุมัติคำขอเบิกภายใน
INSERT INTO platform.approval_policies (doc_type, min_amount, max_amount, step_order, approver_role_id, condition_key)
SELECT 'COUNT_ADJUST', 0, NULL, 1, r.id, NULL FROM platform.roles r WHERE r.code = 'manager'
  AND NOT EXISTS (SELECT 1 FROM platform.approval_policies p WHERE p.doc_type = 'COUNT_ADJUST');

INSERT INTO platform.approval_policies (doc_type, min_amount, max_amount, step_order, approver_role_id, condition_key)
SELECT 'ISSUE', 0, NULL, 1, r.id, NULL FROM platform.roles r WHERE r.code = 'dept_head'
  AND NOT EXISTS (SELECT 1 FROM platform.approval_policies p WHERE p.doc_type = 'ISSUE');
