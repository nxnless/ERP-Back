-- ข้อมูลอ้างอิงที่โมดูลบัญชีต้องใช้ (รันซ้ำได้ ไม่ทับของเดิม) — รันหลัง erp_tables.sql และ seed ของ Admin
-- ตารางทั้งหมด (accounting.*) มาจาก erp_tables.sql แล้ว ไฟล์นี้ใส่เฉพาะข้อมูล
-- สิทธิ์โมดูล accounting/payroll ของบทบาทบัญชีถูกตั้งไว้แล้วใน admin/seed.sql

-- ผังบัญชีเริ่มต้น — ถ้าบริษัทมีผังบัญชีของตัวเองอยู่แล้ว ข้ามส่วนนี้ได้ แต่ต้องมีรหัสบัญชีคุมยอดตาม lib/rules.ts (AR_CONTROL/AP_CONTROL/ACCRUED_PAYROLL)
INSERT INTO accounting.accounts (code, name, type, normal_side) VALUES
  ('1010','เงินสดและเงินฝากธนาคาร','asset','D'), ('1120','ลูกหนี้การค้า','asset','D'), ('1140','ภาษีซื้อ','asset','D'),
  ('1310','สินค้าคงเหลือ','asset','D'), ('1510','อาคารและอุปกรณ์สุทธิ','asset','D'),
  ('2110','เจ้าหนี้การค้า','liability','C'), ('2210','ภาษีขาย','liability','C'), ('2220','ภาษีหัก ณ ที่จ่ายค้างจ่าย','liability','C'), ('2310','เงินเดือนค้างจ่าย','liability','C'),
  ('3100','ทุนเรือนหุ้น','equity','C'), ('3200','กำไรสะสม','equity','C'),
  ('4100','รายได้จากการขาย','revenue','C'),
  ('5100','ต้นทุนขาย','expense','D'), ('5200','เงินเดือนและค่าจ้าง','expense','D'), ('5300','ค่าใช้จ่ายขายและบริหาร','expense','D')
ON CONFLICT (code) DO NOTHING;

-- บัญชีธนาคารที่ผูกกับบัญชี 1010 (ปรับชื่อ/เลขบัญชีให้ตรงกับของบริษัท)
INSERT INTO accounting.bank_accounts (code, bank_name, account_no_masked, gl_account_id)
SELECT 'KBANK-01', 'กสิกรไทย', 'xxx-x-xx789-0', a.id FROM accounting.accounts a WHERE a.code = '1010'
ON CONFLICT (code) DO NOTHING;

-- นโยบายอนุมัติจ่ายเจ้าหนี้ (ปุ่ม "เสนอจ่าย"): ผู้จัดการบัญชี → ถ้าเกิน 500,000 ต้องผู้บริหารด้วย (Admin ปรับได้ที่ Workflow อนุมัติ)
INSERT INTO platform.approval_policies (doc_type, min_amount, max_amount, step_order, approver_role_id, condition_key)
SELECT 'PAYMENT', v.mn, NULL, v.step, r.id, NULL FROM (VALUES (0::numeric, 1, 'accounting_manager'), (500000.01::numeric, 2, 'executive')) AS v(mn, step, rc)
  JOIN platform.roles r ON r.code = v.rc
 WHERE NOT EXISTS (SELECT 1 FROM platform.approval_policies p WHERE p.doc_type = 'PAYMENT');
