/**
 * QUALITY-2026-07-12 WS4 — Pg-backed DB-authoritative authorization loader.
 *
 * Loads the caller's live membership row (canonical id + role + access state) for a tenant so
 * `resolveAuthorization` (middleware/auth.ts) can gate on the DB rather than the
 * Clerk JWT claim. Extracted into its own factory (mirroring
 * `createVapiSecretResolver`) so its SQL — and the exact column names it depends
 * on (`role`, `status`, `deleted_at`) — is pinned by a Docker-gated integration
 * test rather than only proven against a mocked Pool. (CLAUDE.md: "Tests that
 * mock the DB are never the only proof a query works.")
 *
 * Isolation: the query filters on `tenant_id` explicitly, which is what isolates
 * tenants (RLS is a runtime no-op unless RLS_RUNTIME_ROLE is enabled; the
 * predicate is authoritative either way). This mirrors the existing
 * `userModeService.getUser` seam, which reads the same table with a plain
 * `pool.query` and an explicit `tenant_id` predicate.
 *
 * Errors are DELIBERATELY allowed to propagate: `resolveAuthorization` must fail
 * closed on a DB error, so this loader must NOT swallow one into a null (which
 * the middleware would read as "no membership" → a permanent 403 instead of a
 * transient 503).
 */
import type { Pool } from 'pg';
import type { AuthorizationLoader, MembershipRecord } from '../middleware/auth';

export function createAuthorizationLoader(pool: Pool): AuthorizationLoader {
  return async (userId: string, tenantId: string): Promise<MembershipRecord | null> => {
    // `userId` is the Clerk subject (req.auth.userId = payload.sub), so the
    // lookup matches on clerk_user_id — exactly like userModeService.getUser.
    const r = await pool.query<{
      id: string;
      role: string;
      status: string | null;
      deleted_at: Date | null;
    }>(
      `SELECT id, role, status, deleted_at
         FROM users
        WHERE tenant_id = $1 AND clerk_user_id = $2
        LIMIT 1`,
      [tenantId, userId],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    return {
      userId: row.id,
      role: String(row.role),
      status: row.status ? String(row.status) : 'active',
      deleted: row.deleted_at != null,
    };
  };
}
