import type { Pool } from 'pg';
import type { AuthenticatedRequest } from './clerk';
import { withTenantClient } from '../db/tenant-transaction';

/**
 * Resolve the authenticated owner's email for billing / Stripe flows.
 *
 * Prefer `req.clerkUser.email` when the auth layer populated it (JWT claim
 * or test harness). Otherwise look up the users row for this Clerk subject,
 * then fall back to `tenants.owner_email`. The serviceos JWT historically
 * only carried tenant_id + role, so production requests often had no email
 * on the request — which broke checkout with
 * "Owner email not present on auth context".
 *
 * The lookup runs under the request tenant's context (raw-pg audit 2026-10-23
 * §4 P2.3). Its callers — POST /api/onboarding/billing/checkout-session,
 * POST /api/billing/portal-session and POST /api/billing/connect/onboarding —
 * sit behind the /api request transaction, so it rides that client (no
 * second connection); with no request transaction for this tenant it is one
 * tenant session of its own.
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

  const email = await withTenantClient(pool, tenantId, async (client) => {
    const result = await client.query<{ email: string | null }>(
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
    return result.rows[0]?.email?.trim();
  });
  return email || null;
}
