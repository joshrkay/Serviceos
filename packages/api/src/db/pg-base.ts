import { Pool, PoolClient } from 'pg';
import { applyTenantContext, applyCrossTenantRole, clearTenantContext } from './rls-runtime-role';
import { tenantContextStore } from '../middleware/tenant-context';

/**
 * Base class for all Postgres-backed repositories.
 * Provides tenant-scoped query execution via RLS context setting.
 */
export class PgBaseRepository {
  constructor(protected readonly pool: Pool) {}

  /**
   * Execute a callback within a tenant-scoped database context.
   * Sets `app.current_tenant_id` so RLS policies filter automatically.
   *
   * P0-024: when invoked from inside a request that owns a transaction-
   * scoped client (set up by the `withTenantTransaction` middleware),
   * we reuse that client so every query in the request runs inside the
   * same transaction with the same `SET LOCAL` GUC. When invoked outside
   * that scope (workers, public flows, tests), we fall back to the
   * original per-call connection acquisition.
   *
   * GUC leak fix: before releasing the connection back to the pool we
   * issue `RESET app.current_tenant_id`. Without it, the plain `SET`
   * persists on the underlying connection and the next checkout would
   * inherit this tenant's context — silently bypassing RLS for any
   * unscoped query until something else overwrites the GUC.
   */
  protected async withTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const ctx = tenantContextStore.getStore();
    if (ctx && ctx.tenantId === tenantId) {
      // Request-scoped client — already inside a transaction with
      // app.current_tenant_id set LOCAL. Don't re-set, don't re-connect,
      // don't release (the middleware owns the lifecycle).
      return fn(ctx.client);
    }
    // FOLLOW-UP (scale-to-1000 U2b-2): the standalone path below uses a plain
    // session `SET` (via applyTenantContext non-transactional), which is unsafe
    // under PgBouncer transaction pooling when RLS_RUNTIME_ROLE is ON — the SET
    // and the queries can land on different backends. Converting this to a
    // SET LOCAL transaction (like withTenantTransaction) shifts the observable
    // query sequence and requires coordinated updates to ~15 repo-invariant
    // test files, so it is tracked separately. No production exposure today:
    // RLS is off by default and in-request reads reuse the request transaction
    // above. MUST land before enabling RLS_RUNTIME_ROLE in production.
    const client = await this.pool.connect();
    try {
      await applyTenantContext(client, tenantId);
      return await fn(client);
    } finally {
      // GUC/role leak fix: session-level `SET` persists on the underlying
      // connection past COMMIT/ROLLBACK. Clear the GUC AND the RLS runtime
      // role explicitly before release so the next pool checkout doesn't
      // inherit this tenant's context or run as the restricted role.
      await clearTenantContext(client);
      client.release();
    }
  }

  /**
   * Execute a callback within a tenant-scoped transaction.
   * Rolls back on error.
   *
   * P0-024 + Codex P1 follow-up: when invoked from inside a request
   * that owns a transaction-scoped client (set up by the
   * `withTenantTransaction` middleware), reuse that client and SKIP
   * the inner BEGIN/COMMIT/ROLLBACK — the middleware already owns
   * the transaction lifecycle for the entire request. Calling
   * `BEGIN` again on the same client would either error
   * ("already in transaction") or be a no-op depending on
   * configuration; either way it's wrong. On caller error, the
   * exception propagates up; the middleware's `res.once('close')`
   * triggers a ROLLBACK of the whole-request transaction.
   *
   * Without this reuse, a write path under a 1-connection pool would
   * deadlock: the middleware holds client A until response.finish,
   * but the repo would call pool.connect() and wait for client B
   * which can't be acquired until A releases.
   *
   * Outside the request scope (workers, public flows, tests), we
   * still do the full BEGIN/COMMIT/ROLLBACK on a fresh connection.
   */
  protected async withTenantTransaction<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const ctx = tenantContextStore.getStore();
    if (ctx && ctx.tenantId === tenantId) {
      return fn(ctx.client);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Transactional context: SET LOCAL config + role auto-reset at
      // COMMIT/ROLLBACK, so no leak survives the transaction.
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
      // Belt-and-suspenders: the SET LOCAL above auto-resets at COMMIT/
      // ROLLBACK, but clear explicitly too so a broken/edge state can't leak
      // the GUC or the restricted role to the next pool checkout.
      await clearTenantContext(client);
      client.release();
    }
  }

  /**
   * Execute a query without tenant context (for global tables like vertical_packs).
   */
  protected async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  /**
   * Execute an INTENTIONAL cross-tenant sweep (the proposal execution sweep and
   * the recovery/retention drains) over tenant-scoped tables. Like `withClient`,
   * but when `RLS_RUNTIME_ROLE` is on it runs as the named, auditable
   * `rls_cross_tenant` (BYPASSRLS) role so the cross-tenant access is explicit
   * and attributable rather than an anonymous privileged query. Resets the role
   * on release (same pool-leak discipline as the tenant path). No-op vs.
   * `withClient` when the flag is off (or when the role is unprovisioned — see
   * applyCrossTenantRole's documented fallback to the connection principal).
   */
  protected async withCrossTenantSweep<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    // FOLLOW-UP (scale-to-1000 U2b-2): like withTenant's standalone path, the
    // session `SET ROLE` here is unsafe under PgBouncer transaction pooling when
    // RLS_RUNTIME_ROLE is ON. Converting to a SET LOCAL ROLE transaction is
    // tracked with the withTenant conversion (shifts query sequence in sweep
    // tests). No exposure today (RLS off by default).
    const client = await this.pool.connect();
    try {
      await applyCrossTenantRole(client);
      return await fn(client);
    } finally {
      await clearTenantContext(client);
      client.release();
    }
  }
}
