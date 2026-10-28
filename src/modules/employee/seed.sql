-- ข้อมูลอ้างอิงขั้นต่ำที่โมดูลพนักงานต้องใช้ (รันครั้งเดียว ซ้ำได้ ไม่ทับของเดิม)
-- ถ้ามี roles / นโยบายอนุมัติ / leave_types อยู่แล้ว ให้ข้ามไฟล์นี้

INSERT INTO platform.roles (code, name, can_approve) VALUES
  ('employee','พนักงานทั่วไป',false),('manager','ผู้จัดการ',true),('hr','ฝ่ายบุคคล',true),
  ('dept_head','หัวหน้าแผนก',true),('accounting','บัญชี/การเงิน',true),('executive','ผู้บริหาร',true),
  ('auditor','ผู้ตรวจสอบ',false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO hr.leave_types (code, name, annual_days, carry_over_days, notice_days, cert_required_from_days, statutory) VALUES
  ('vacation','ลาพักร้อน',10,5,3,NULL,false),('sick','ลาป่วย',30,0,0,3,false),
  ('personal','ลากิจ',3,0,2,NULL,false),('maternity','ลาคลอด',120,0,0,NULL,true)
ON CONFLICT (code) DO NOTHING;

-- นโยบายอนุมัติที่ฟอร์มพนักงานใช้ (Admin ปรับได้ภายหลัง)
INSERT INTO platform.approval_policies (doc_type, min_amount, max_amount, step_order, approver_role_id, condition_key)
SELECT v.dt, v.mn, NULL, v.st, r.id, v.ck FROM (VALUES
  ('LEAVE',0,1,'manager',NULL),('LEAVE',0,2,'hr','over_quota'),
  ('OT',0,1,'manager',NULL),
  ('EXPENSE',0,1,'manager',NULL),('EXPENSE',10000.01,2,'accounting',NULL),('EXPENSE',50000.01,3,'executive',NULL),
  ('PR',0,1,'dept_head',NULL),('ISSUE',0,1,'dept_head',NULL),
  ('DATA_CHANGE',0,1,'hr',NULL),('BANK_CHANGE',0,1,'hr',NULL)
) AS v(dt, mn, st, rc, ck)
JOIN platform.roles r ON r.code = v.rc
WHERE NOT EXISTS (SELECT 1 FROM platform.approval_policies p WHERE p.doc_type = v.dt AND p.step_order = v.st);

-- ให้สิทธิ์ลาประจำปีปัจจุบันแก่พนักงานที่ยังไม่มี (ควรตั้งเป็นงานต้นปี)
INSERT INTO hr.leave_ledger (employee_id, leave_type_code, year, days, reason)
SELECT e.id, t.code, extract(year FROM now() AT TIME ZONE 'Asia/Bangkok')::int, t.annual_days, 'grant'
  FROM hr.employees e CROSS JOIN hr.leave_types t
 WHERE e.status <> 'resigned' AND NOT t.statutory
   AND NOT EXISTS (SELECT 1 FROM hr.leave_ledger l WHERE l.employee_id = e.id AND l.leave_type_code = t.code
                    AND l.year = extract(year FROM now() AT TIME ZONE 'Asia/Bangkok')::int AND l.reason = 'grant');
