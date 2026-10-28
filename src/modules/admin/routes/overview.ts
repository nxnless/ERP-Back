import { Elysia } from 'elysia'
import { sql } from '../../../shared/db'
import { adminOnly } from '../guard'
import { DOC_TYPES } from '../lib/rules'

export const overviewRoutes = new Elysia()
  .use(adminOnly)
  .get('/overview', async () => {
    const [[u], [a], [mod], [rl], [acc], withPolicy, recent] = await Promise.all([
      sql`SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'suspended')::int AS suspended, count(*) FILTER (WHERE status = 'invited')::int AS invited FROM platform.users`,
      sql`SELECT count(DISTINCT u.id)::int AS n FROM platform.users u JOIN platform.user_roles ur ON ur.user_id = u.id JOIN platform.roles r ON r.id = ur.role_id WHERE r.code = 'admin' AND u.status = 'active'`,
      sql`SELECT count(*) FILTER (WHERE enabled)::int AS enabled, count(*)::int AS total FROM platform.modules`,
      sql`SELECT count(*)::int AS n FROM platform.roles`,
      sql`SELECT count(*)::int AS n FROM platform.requests r WHERE r.type = 'ACCOUNT' AND r.status = 'pending'
            AND EXISTS (SELECT 1 FROM platform.request_steps s JOIN platform.roles ro ON ro.id = s.approver_role_id WHERE s.request_id = r.id AND s.status = 'pending' AND ro.code = 'admin')`,
      sql`SELECT DISTINCT doc_type FROM platform.approval_policies WHERE active`,
      sql`SELECT occurred_at, actor_name, action, entity_ref, risk FROM audit.audit_log WHERE module = 'platform' ORDER BY occurred_at DESC, id DESC LIMIT 8`,
    ])
    const covered = new Set(withPolicy.map((r) => r.doc_type))
    return {
      users: u, admins_active: a.n, modules: mod, roles: rl.n, pending_accounts: acc.n,
      types_without_policy: Object.entries(DOC_TYPES).filter(([k]) => !covered.has(k)).map(([type, label]) => ({ type, label })),
      recent,
    }
  })
