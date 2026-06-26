import { Pool, PoolClient } from 'pg';
import { setTenantContext } from './schema';

/**
 * RLS runtime-role enforcement (see docs/plans/2026-06-25-005-...).
 *
 * The app connects to Postgres as a privileged principal (it must run
 * migrations and own the view-token SECURITY DEFINER functions), so RLS is a
 * runtime no-op by default. When `RLS_RUNTIME_ROLE=true`, every tenant-scoped
 * query additionally `SET ROLE`s into the least-privilege, RLS-subject
 * `rls_app_runtime` role (provisioned by migration 217), so the policies
 * actually enforce — a forgotten `tenant_id` filter can no longer cross tenants.
 *
 * Flag OFF (default) → behavior is byte-for-byte today's: only the GUC is set.
 */

const RLS_ROLE = 'rls_app_runtime';
// Named role for INTENTIONAL cross-tenant access (the proposal execution sweep,
// findAllActive cursors). BYPASSRLS — same capability as the connection
// principal — so this is auditability, not privilege reduction: cross-tenant
// access becomes an explicit, attributable role instead of an anonymous
// privileged query. Provisioned by migration 220. (docs/plans/2026-06-25-006-...)
const CROSS_TENANT_ROLE = 'rls_cross_tenant';

export function isRlsRuntimeRoleEnabled(): boolean {
  return process.env.RLS_RUNTIME_ROLE === 'true';
}

/**
 * Establish tenant context on a client: set `app.current_tenant_id` and, when
 * enabled, drop to the RLS runtime role.
 *
 * - `transactional: true` — uses `SET LOCAL` (config + role), which Postgres
 *   auto-resets at COMMIT/ROLLBACK. The caller MUST already be inside a
 *   transaction. No `clearTenantContext` needed.
 * - `transactional: false` (default) — session-level `SET`. The caller MUST
 *   call `clearTenantContext(client)` before returning the connection to the
 *   pool, or the role/GUC leaks to the next checkout (a privileged sweep would
 *   then run as the restricted role).
 */
export async function applyTenantContext(
  client: PoolClient,
  tenantId: string,
  opts: { transactional?: boolean } = {}
): Promise<void> {
  const roleEnabled = isRlsRuntimeRoleEnabled();
  if (opts.transactional) {
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    if (roleEnabled) {
      await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
    }
  } else {
    // setTenantContext validates the UUID and returns `SET app.current_tenant_id = '<uuid>'`.
    await client.query(setTenantContext(tenantId));
    if (roleEnabled) {
      await client.query(`SET ROLE ${RLS_ROLE}`);
    }
  }
}

/**
 * Drop to the named cross-tenant sweep role for INTENTIONAL cross-tenant access
 * (no `app.current_tenant_id` is set — the whole point is to span tenants).
 * Session-level `SET ROLE`; the caller MUST `clearTenantContext(client)` before
 * release (reuses the same RESET ROLE path). No-op when the flag is off, so the
 * sweep runs as the connection principal exactly like today.
 */
export async function applyCrossTenantRole(client: PoolClient): Promise<void> {
  if (isRlsRuntimeRoleEnabled()) {
    await client.query(`SET ROLE ${CROSS_TENANT_ROLE}`);
  }
}

/**
 * Reset session-level tenant context + role before returning a client to the
 * pool. Tolerant of broken connections (pg discards them on error). Resets the
 * role first (back to the connection principal), then the GUC.
 */
export async function clearTenantContext(client: PoolClient): Promise<void> {
  try {
    await client.query('RESET ROLE');
  } catch {
    // ignore — connection is being released; a broken client is discarded by pg.
  }
  try {
    await client.query('RESET app.current_tenant_id');
  } catch {
    // ignore — see above.
  }
}

/**
 * Boot-time guard. When `RLS_RUNTIME_ROLE=true`, verify the role is actually
 * assumable and **throw** (refuse to boot) if not — so the app never runs with
 * the flag on while enforcement is silently absent (a false sense of security).
 * No-op when the flag is off.
 */
export async function verifyRlsRuntimeRole(pool: Pool): Promise<void> {
  if (!isRlsRuntimeRoleEnabled()) return;
  const client = await pool.connect();
  try {
    for (const role of [RLS_ROLE, CROSS_TENANT_ROLE]) {
      try {
        await client.query(`SET ROLE ${role}`);
        await client.query('RESET ROLE');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `RLS_RUNTIME_ROLE=true but the '${role}' role is not assumable (${msg}). ` +
            `Provision it (migrations 217/220 run CREATE ROLE + GRANT; rls_cross_tenant needs ` +
            `SUPERUSER to create as BYPASSRLS) and grant membership to the app's DB principal, ` +
            `or unset RLS_RUNTIME_ROLE.`
        );
      }
    }
  } finally {
    client.release();
  }
}
