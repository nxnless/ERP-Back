-- ข้อมูลอ้างอิงที่โมดูล Admin ต้องใช้ (รันซ้ำได้ ไม่ทับของเดิม) — ข้ามได้ถ้ามีบทบาท/โมดูลอยู่แล้ว
INSERT INTO platform.roles (code, name, can_approve) VALUES
  ('admin','ผู้ดูแลระบบ',false),('executive','ผู้บริหาร',true),('manager','ผู้จัดการ',true),('dept_head','หัวหน้าแผนก',true),
  ('purchasing_head','หัวหน้าจัดซื้อ',true),('accounting','บัญชี/การเงิน',true),('accounting_manager','ผู้จัดการบัญชี',true),
  ('sales','ฝ่ายขาย',false),('purchasing','ฝ่ายจัดซื้อ',false),('warehouse','คลังสินค้า',false),('hr','ฝ่ายบุคคล',true),
  ('auditor','ผู้ตรวจสอบ',false),('employee','พนักงานทั่วไป',false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO platform.modules (code, name) VALUES
  ('sales','ขาย'),('crm','CRM'),('purchasing','จัดซื้อ'),('inventory','คลังสินค้า'),('accounting','บัญชีและการเงิน'),
  ('payroll','เงินเดือน'),('hr','ทะเบียนพนักงานและลา'),('settings','ตั้งค่าระบบ'),('audit','Audit Log')
ON CONFLICT (code) DO NOTHING;

-- สิทธิ์เริ่มต้น: Admin ตั้งค่าระบบ + ดู Audit เท่านั้น (ไม่มีโมดูลธุรกิจ)
INSERT INTO platform.role_module_access (role_id, module_code, level)
SELECT r.id, v.m, v.l FROM (VALUES
  ('admin','settings','manage'),('admin','audit','read'),
  ('executive','sales','read'),('executive','crm','read'),('executive','purchasing','read'),('executive','inventory','read'),('executive','accounting','read'),('executive','payroll','read'),('executive','hr','read'),('executive','audit','read'),
  ('manager','sales','write'),('manager','crm','read'),('manager','purchasing','write'),('manager','inventory','read'),('manager','accounting','read'),('manager','payroll','write'),('manager','hr','read'),
  ('dept_head','inventory','read'),('purchasing_head','purchasing','write'),('purchasing_head','inventory','read'),
  ('accounting','accounting','write'),('accounting','sales','read'),('accounting','purchasing','read'),('accounting','inventory','read'),('accounting','payroll','read'),
  ('accounting_manager','accounting','write'),('accounting_manager','sales','read'),('accounting_manager','purchasing','read'),('accounting_manager','inventory','read'),('accounting_manager','payroll','read'),
  ('sales','sales','write'),('sales','crm','write'),('purchasing','purchasing','write'),('purchasing','inventory','read'),('warehouse','inventory','write'),
  ('hr','hr','write'),('hr','payroll','write'),
  ('auditor','sales','read'),('auditor','crm','read'),('auditor','purchasing','read'),('auditor','inventory','read'),('auditor','accounting','read'),('auditor','payroll','read'),('auditor','hr','read'),('auditor','audit','read')
) AS v(rc, m, l) JOIN platform.roles r ON r.code = v.rc
ON CONFLICT (role_id, module_code) DO NOTHING;

-- คำขอเปิดบัญชีผู้ใช้ → ให้ Admin ดำเนินการ (ขั้นเดียว)
INSERT INTO platform.approval_policies (doc_type, min_amount, max_amount, step_order, approver_role_id, condition_key)
SELECT 'ACCOUNT', 0, NULL, 1, r.id, NULL FROM platform.roles r WHERE r.code = 'admin'
  AND NOT EXISTS (SELECT 1 FROM platform.approval_policies p WHERE p.doc_type = 'ACCOUNT');
