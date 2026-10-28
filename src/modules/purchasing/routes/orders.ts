import { Elysia, t } from 'elysia'
import { sql } from '../../../shared/db'
import { HttpError } from '../../../shared/errors'
import { purchasingOnly } from '../guard'
import { issuePo, loadSupplier, toPoLines, userBranch } from '../lib/po'
import { UUID } from '../lib/rules'

export const orderRoutes = new Elysia()
  .use(purchasingOnly)

  // ใบขอซื้อ: ที่อนุมัติแล้ว (รอออก PO) + ที่ยังรออนุมัติ + ที่ออก PO แล้วใน 30 วัน
  .get('/requisitions', async () => await sql`
    SELECT pr.id, pr.doc_no, pr.status, pr.need_by, pr.reason, pr.created_at, d.name AS department_name, u.display_name AS requester_name,
           COALESCE(json_agg(json_build_object('line_no', l.line_no, 'description', l.description, 'qty', l.qty::float8, 'uom', l.uom,
                     'est_unit_price', l.est_unit_price::float8, 'est_total', l.est_total::float8) ORDER BY l.line_no) FILTER (WHERE l.id IS NOT NULL), '[]'::json) AS lines,
           COALESCE(sum(l.est_total), 0)::float8 AS est_total,
           (SELECT ro.name FROM platform.request_steps s JOIN platform.roles ro ON ro.id = s.approver_role_id
             WHERE s.request_id = pr.approval_request_id AND s.status = 'pending') AS waiting_role,
           EXISTS (SELECT 1 FROM purchasing.rfqs r WHERE r.pr_id = pr.id AND r.status = 'open') AS has_open_rfq
      FROM purchasing.purchase_requisitions pr
      JOIN platform.users u ON u.id = pr.requester_id LEFT JOIN master.departments d ON d.id = pr.department_id
      LEFT JOIN purchasing.pr_lines l ON l.pr_id = pr.id
     WHERE pr.status IN ('pending_approval','approved','po_issued') AND (pr.status <> 'po_issued' OR pr.updated_at > now() - interval '30 days')
     GROUP BY pr.id, d.name, u.display_name
     ORDER BY (pr.status = 'approved') DESC, pr.created_at DESC LIMIT 200`)

  .get('/orders', async () => await sql`
    SELECT po.id, po.doc_no, po.order_date, po.status, po.subtotal::float8 AS subtotal, po.total::float8 AS total,
           po.party_name_snap AS supplier_name, t.name AS terms_name,
           (SELECT string_agg(ro.name, ' › ' ORDER BY s.seq) FROM platform.request_steps s JOIN platform.roles ro ON ro.id = s.approver_role_id
             WHERE s.request_id = po.approval_request_id) AS route,
           (SELECT ro.name FROM platform.request_steps s JOIN platform.roles ro ON ro.id = s.approver_role_id
             WHERE s.request_id = po.approval_request_id AND s.status = 'pending') AS waiting_role
      FROM purchasing.purchase_orders po LEFT JOIN master.payment_terms t ON t.id = po.payment_terms_id
     ORDER BY po.created_at DESC LIMIT 200`)

  // ออก PO จากใบขอซื้อที่อนุมัติแล้ว — ใช้ราคาประเมินในใบขอซื้อ ผู้อนุมัติ PO ตามวงเงิน (ก่อน VAT) ในนโยบาย
  .post('/requisitions/:id/issue-po', async ({ params, body, session, ip }) => {
    const [pr] = await sql`SELECT id, doc_no, status, branch_id FROM purchasing.purchase_requisitions WHERE id = ${params.id}`
    if (!pr) throw new HttpError(404, 'ไม่พบใบขอซื้อ')
    if (pr.status !== 'approved') throw new HttpError(409, 'ใบขอซื้อนี้ยังไม่อนุมัติ หรือออก PO ไปแล้ว')
    if ((await sql`SELECT 1 FROM purchasing.rfqs WHERE pr_id = ${pr.id} AND status = 'open'`).length)
      throw new HttpError(409, 'ใบขอซื้อนี้มี RFQ ที่ยังเปิดอยู่ — เลือกผู้ขายจากหน้าเปรียบเทียบราคา')
    const supplier = await loadSupplier(body.supplier_id)
    const rows = await sql`SELECT item_id, description, uom, qty::float8 AS qty, est_unit_price::float8 AS price FROM purchasing.pr_lines WHERE pr_id = ${pr.id} ORDER BY line_no`
    const lines = await toPoLines(rows as any)
    const branchId = await userBranch(session.userId, pr.branch_id)
    return await issuePo({ session, ip }, {
      supplier, lines, branchId, prId: pr.id, auditAction: 'issue_po', auditExtra: { from: pr.doc_no },
      extra: (po) => [
        sql`UPDATE purchasing.purchase_requisitions SET status = 'po_issued', updated_at = now() WHERE id = ${pr.id} AND status = 'approved'`,
        sql`INSERT INTO platform.doc_links (from_table, from_id, to_table, to_id) VALUES ('purchasing.purchase_requisitions', ${pr.id}, 'purchasing.purchase_orders', ${po.id}) ON CONFLICT DO NOTHING`,
      ],
    })
  }, { params: t.Object({ id: UUID }), body: t.Object({ supplier_id: UUID }) })
