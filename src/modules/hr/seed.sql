-- ข้อมูลอ้างอิงที่โมดูล HR ต้องใช้ (รันซ้ำได้ ไม่ทับของเดิม) — รันหลัง erp_tables.sql และ seed ของ Admin
-- ตารางทั้งหมด (hr.*, master.departments ฯลฯ) มาจาก erp_tables.sql แล้ว ไฟล์นี้ใส่เฉพาะข้อมูล
-- สิทธิ์โมดูล hr/payroll ของบทบาท hr ถูกตั้งไว้แล้วใน admin/seed.sql (hr: hr=write, payroll=write)

-- ประเภทการลา/นโยบายลา (HR แก้ที่หน้า "ใบลาและนโยบายลา") — ถ้าโมดูล employee ใช้รหัสอื่นอยู่แล้ว ให้ปรับ code ให้ตรงก่อนรัน
INSERT INTO hr.leave_types (code, name, annual_days, carry_over_days, notice_days, cert_required_from_days, statutory) VALUES
  ('vacation','ลาพักร้อน',10,5,3,NULL,false), ('sick','ลาป่วย',30,0,0,3,false),
  ('personal','ลากิจ',3,0,2,NULL,false), ('maternity','ลาคลอด',120,0,0,NULL,true)
ON CONFLICT (code) DO NOTHING;

-- แผนกและอัตรากำลังตามแผน
INSERT INTO master.departments (code, name, planned_headcount) VALUES
  ('SALES','ฝ่ายขาย',13), ('PUR','จัดซื้อ',4), ('WH','คลังสินค้า',10), ('ACC','บัญชีและการเงิน',5),
  ('HR','HR',2), ('IT','IT/ระบบ',2), ('EXEC','ผู้บริหาร',3), ('PROD','ผลิต',6)
ON CONFLICT (code) DO NOTHING;

-- นโยบายอนุมัติรอบเงินเดือน: บัญชีตรวจ → ผู้จัดการอนุมัติ (Admin ปรับได้ที่ Workflow อนุมัติ) — ไม่มีนโยบาย = HR ส่งรอบไม่ได้
INSERT INTO platform.approval_policies (doc_type, min_amount, max_amount, step_order, approver_role_id, condition_key)
SELECT 'PAYROLL', 0, NULL, v.step, r.id, NULL FROM (VALUES (1,'accounting'),(2,'manager')) AS v(step, rc)
  JOIN platform.roles r ON r.code = v.rc
 WHERE NOT EXISTS (SELECT 1 FROM platform.approval_policies p WHERE p.doc_type = 'PAYROLL');
