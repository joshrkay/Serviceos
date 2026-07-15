import type { Pool } from 'pg';
import type { AuthenticatedRequest } from './clerk';

/**
 * Resolve the authenticated owner's email for billing / Stripe flows.
 *
 * Prefer `req.clerkUser.email` when the auth layer populated it (JWT claim
 * or test harness). Otherwise look up the users row for this Clerk subject,
 * then fall back to `tenants.owner_email`. The serviceos JWT historically
 * only carried tenant_id + role, so production requests often had no email
 * on the request — which broke checkout with
 * "Owner email not present on auth context".
 */
export async function resolveOwnerEmail(
  req: AuthenticatedRequest,
  pool?: Pool,
): Promise<string | null> {
  const fromClerk = req.clerkUser?.email?.trim();
  if (fromClerk) return fromClerk;

  const tenantId = req.auth?.tenantId;
  const userId = req.auth?.userId;
  if (!pool || !tenantId) return null;

  const result = await pool.query<{ email: string | null }>(
    `SELECT COALESCE(
       (SELECT email FROM users
         WHERE tenant_id = $1
           AND clerk_user_id = $2
           AND deleted_at IS NULL
         LIMIT 1),
       (SELECT owner_email FROM tenants WHERE id = $1)
     ) AS email`,
    [tenantId, userId ?? null],
  );
  const email = result.rows[0]?.email?.trim();
  return email || null;
}
