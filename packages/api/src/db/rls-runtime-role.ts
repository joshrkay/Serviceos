import { Pool, PoolClient } from 'pg';
import { setTenantContext, isValidTenantId } from './schema';

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
// Named role for INTENTIONAL cross-tenant access (the proposal execution sweep
// and the recovery/retention drains — see withCrossTenantSweep callers).
// BYPASSRLS — same capability as the connection principal — so this is
// auditability, not privilege reduction: cross-tenant access becomes an
// explicit, attributable role instead of an anonymous privileged query.
// Provisioned by migration 220. (docs/plans/2026-06-25-006-...)
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
    // The session path validates via setTenantContext; the transactional path
    // parameterizes the GUC so we must validate the UUID here too — otherwise a
    // malformed tenant id silently becomes a GUC string instead of throwing
    // (U2b-2: withTenant now routes through this path).
    if (!isValidTenantId(tenantId)) {
      throw new Error('Invalid tenant ID format: must be a valid UUID');
    }
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
 *
 * Graceful degradation: `rls_cross_tenant` is BYPASSRLS, which needs SUPERUSER
 * to create — managed Postgres often withholds it, so the role may be absent
 * even with the flag on. If `SET ROLE` fails we fall back to the connection
 * principal (same BYPASSRLS capability, just unattributed in DB audit logs).
 * `SET ROLE` fails before any statement runs and opens no transaction, so the
 * client is safe to reuse as the principal. `verifyRlsRuntimeRole` warns about
 * the absence once at boot so the unattributed access is never a surprise.
 */
export async function applyCrossTenantRole(
  client: PoolClient,
  opts: { transactional?: boolean } = {},
): Promise<void> {
  if (!isRlsRuntimeRoleEnabled()) return;
  // SET LOCAL ROLE auto-resets at COMMIT/ROLLBACK (PgBouncer transaction-pooling
  // safe); plain SET ROLE is session-level and needs clearTenantContext.
  const stmt = opts.transactional
    ? `SET LOCAL ROLE ${CROSS_TENANT_ROLE}`
    : `SET ROLE ${CROSS_TENANT_ROLE}`;
  try {
    await client.query(stmt);
  } catch {
    // Role unprovisioned/ungranted → run as the connection principal (the
    // documented fallback). See JSDoc above.
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
 * Pooling-safe ad-hoc tenant-scoped work: connect, `BEGIN`, set tenant context
 * with `SET LOCAL`, run `fn`, `COMMIT` (`ROLLBACK` on throw), release. Use this
 * for tenant-scoped work that manages its OWN pool connection (analytics /
 * digest builders) instead of the plain-`SET` + `clearTenantContext` pattern,
 * which is UNSAFE under PgBouncer transaction pooling — the `SET` and the
 * queries are separate implicit transactions that can land on different
 * backends, dropping the tenant GUC/role. Mirrors
 * `PgBaseRepository.withTenantTransaction` for non-repository callers.
 */
export async function withTenantSession<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyTenantContext(client, tenantId, { transactional: true });
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // best-effort rollback
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Boot-time guard. When `RLS_RUNTIME_ROLE=true`:
 *
 * - `rls_app_runtime` (the enforcement role) MUST be assumable — **throw**
 *   (refuse to boot) if not, so the app never runs with the flag on while
 *   enforcement is silently absent (a false sense of security).
 * - `rls_cross_tenant` (the auditability-only sweep role) is OPTIONAL — it's
 *   BYPASSRLS (same capability as the connection principal), and creating it
 *   needs SUPERUSER, which managed Postgres often withholds. If it's absent we
 *   **warn and continue**: the intentional sweeps fall back to the connection
 *   principal (correct, just unattributed). Blocking the real RLS-enforcement
 *   rollout on an audit-only role would be the wrong trade.
 *
 * No-op when the flag is off.
 */
export async function verifyRlsRuntimeRole(pool: Pool): Promise<void> {
  if (!isRlsRuntimeRoleEnabled()) return;
  const client = await pool.connect();
  try {
    await probeRoleAssumable(client, RLS_ROLE, { required: true });
    await probeRoleAssumable(client, CROSS_TENANT_ROLE, { required: false });
  } finally {
    client.release();
  }
}

/**
 * Probe whether `role` is assumable by the current principal (SET ROLE then
 * RESET). A `required` role that isn't assumable throws; an optional one warns
 * and resolves so boot continues with the documented degraded behavior.
 */
async function probeRoleAssumable(
  client: PoolClient,
  role: string,
  opts: { required: boolean }
): Promise<void> {
  try {
    await client.query(`SET ROLE ${role}`);
    await client.query('RESET ROLE');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.required) {
      throw new Error(
        `RLS_RUNTIME_ROLE=true but the '${role}' role is not assumable (${msg}). ` +
          `Provision it (migration 217 runs CREATE ROLE + GRANT) and grant membership ` +
          `to the app's DB principal, or unset RLS_RUNTIME_ROLE.`
      );
    }
    console.warn(
      `[rls] RLS_RUNTIME_ROLE=true but the optional '${role}' role is not assumable ` +
        `(${msg}); intentional cross-tenant sweeps will run as the connection principal ` +
        `(correct, just unattributed). Provision it as a SUPERUSER (migration 220 / runbook) ` +
        `to restore attributable access.`
    );
  }
}
