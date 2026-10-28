-- นโยบายอนุมัติเริ่มต้นที่โมดูลจัดซื้อต้องใช้ (รันซ้ำได้ — ไม่ทับถ้า Admin ตั้งนโยบายประเภทนั้นไว้แล้ว)
-- รันหลัง admin/seed.sql (ต้องมีบทบาทและโมดูลอยู่ก่อน) · ปรับวงเงิน/ผู้อนุมัติภายหลังได้ที่หน้า "Workflow อนุมัติ" ของ Admin

-- PO: ตามวงเงินก่อน VAT — ≤ 50,000 หัวหน้าจัดซื้อ · ≤ 500,000 ผู้จัดการ · มากกว่านั้นผู้บริหาร
INSERT INTO platform.approval_policies (doc_type, min_amount, max_amount, step_order, approver_role_id, condition_key)
SELECT 'PO', v.mn, v.mx, 1, r.id, NULL
  FROM (VALUES (0::numeric, 50000::numeric, 'purchasing_head'), (50000.01::numeric, 500000::numeric, 'manager'), (500000.01::numeric, NULL::numeric, 'executive')) AS v(mn, mx, rc)
  JOIN platform.roles r ON r.code = v.rc
 WHERE NOT EXISTS (SELECT 1 FROM platform.approval_policies p WHERE p.doc_type = 'PO');

-- PR (ใบขอซื้อที่จัดซื้อสร้างเอง เช่น เติมสต็อก): หัวหน้าแผนกอนุมัติ ทุกวงเงิน
INSERT INTO platform.approval_policies (doc_type, min_amount, max_amount, step_order, approver_role_id, condition_key)
SELECT 'PR', 0, NULL, 1, r.id, NULL FROM platform.roles r WHERE r.code = 'dept_head'
   AND NOT EXISTS (SELECT 1 FROM platform.approval_policies p WHERE p.doc_type = 'PR');

-- ขอเพิ่มซัพพลายเออร์ใหม่: หัวหน้าจัดซื้อ › ผู้จัดการ
INSERT INTO platform.approval_policies (doc_type, min_amount, max_amount, step_order, approver_role_id, condition_key)
SELECT 'SUPPLIER', 0, NULL, v.s, r.id, NULL
  FROM (VALUES (1, 'purchasing_head'), (2, 'manager')) AS v(s, rc) JOIN platform.roles r ON r.code = v.rc
 WHERE NOT EXISTS (SELECT 1 FROM platform.approval_policies p WHERE p.doc_type = 'SUPPLIER');
