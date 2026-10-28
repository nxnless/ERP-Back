-- ข้อมูลอ้างอิงที่โมดูลผู้จัดการต้องใช้ (รันซ้ำได้ ไม่ทับของเดิม) — ข้ามได้ถ้ารัน admin/seed.sql ไปแล้ว
INSERT INTO platform.roles (code, name, can_approve) VALUES
  ('manager','ผู้จัดการ',true),('executive','ผู้บริหาร',true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO platform.role_module_access (role_id, module_code, level)
SELECT r.id, v.m, v.l FROM (VALUES
  ('manager','sales','write'),('manager','crm','read'),('manager','purchasing','write'),('manager','inventory','read'),
  ('manager','accounting','read'),('manager','payroll','write'),('manager','hr','read')
) AS v(rc, m, l) JOIN platform.roles r ON r.code = v.rc
WHERE EXISTS (SELECT 1 FROM platform.modules WHERE code = v.m)
ON CONFLICT (role_id, module_code) DO NOTHING;

-- เป้ายอดขายตัวอย่าง (เอาคอมเมนต์ออกแล้วแก้รหัสสาขา/แผนก/จำนวนเงิน) — ไม่มีเป้า = หน้า Dashboard/รายงานแสดง "—"
-- INSERT INTO sales.sales_targets (branch_id, department_id, period, amount)
-- SELECT b.id, NULL, date_trunc('month', current_date)::date, 5200000 FROM platform.branches b WHERE b.code = 'CHB'
-- ON CONFLICT DO NOTHING;
