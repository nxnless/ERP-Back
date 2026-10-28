-- ข้อมูลอ้างอิงที่โมดูลฝ่ายขายต้องใช้ (รันซ้ำได้ ไม่ทับของเดิม) — ต้องรัน admin/seed.sql ก่อน (ต้องมีบทบาทและโมดูล)
-- ต้องมี master.price_lists และ master.payment_terms อยู่แล้ว (ฝ่ายขายใช้เลือกกลุ่มราคา/เงื่อนไขชำระ)

-- ขั้นของ CRM Pipeline
INSERT INTO sales.crm_stages (code, name, seq, probability) VALUES
  ('lead','Lead',1,10),('qualified','Qualified',2,30),('proposal','Proposal',3,50),('negotiation','Negotiation',4,75),('won','Won',5,100)
ON CONFLICT DO NOTHING;

-- นโยบายอนุมัติเริ่มต้น (ใส่เฉพาะประเภทที่ยังไม่มีนโยบาย — Admin ปรับได้ที่หน้า Workflow อนุมัติ)
--   ส่วนลดใบเสนอราคา → ผู้จัดการ · ใบเสนอราคาเกิน 100,000 บาท → ผู้บริหาร · ขอยกเว้นเครดิต → ผู้จัดการ แล้วบัญชี
INSERT INTO platform.approval_policies (doc_type, min_amount, max_amount, step_order, approver_role_id, condition_key)
SELECT v.t, v.mn, NULL::numeric, v.st, r.id, NULL
  FROM (VALUES ('QUOTATION_DISCOUNT', 0::numeric, 1, 'manager'), ('QUOTATION', 100000.01::numeric, 1, 'executive'),
               ('CREDIT_EXCEPTION', 0::numeric, 1, 'manager'), ('CREDIT_EXCEPTION', 0::numeric, 2, 'accounting')) AS v(t, mn, st, rc)
  JOIN platform.roles r ON r.code = v.rc
 WHERE NOT EXISTS (SELECT 1 FROM platform.approval_policies p WHERE p.doc_type = v.t);

-- หัวหน้าแผนกขาย: บทบาท dept_head ใช้โมดูลฝ่ายขาย/CRM ได้ (ด่านใน guard.ts ยังตรวจว่าเป็นหัวหน้าแผนกที่มีพนักงานขายอยู่ในแผนกเดียวกัน
-- หัวหน้าแผนกอื่นผ่านด่านนี้ไม่ได้ แม้บทบาทจะมีสิทธิ์) — Admin ปรับได้ที่หน้า "บทบาทและสิทธิ์"
INSERT INTO platform.role_module_access (role_id, module_code, level)
SELECT r.id, v.m, 'write' FROM (VALUES ('sales'), ('crm')) AS v(m) JOIN platform.roles r ON r.code = 'dept_head'
ON CONFLICT (role_id, module_code) DO NOTHING;
