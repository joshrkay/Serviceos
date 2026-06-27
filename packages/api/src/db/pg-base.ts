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
    // U2b-2: the standalone path is now a SET LOCAL transaction — identical to
    // withTenantTransaction — so it is PgBouncer transaction-pooling safe (the
    // GUC/role and the queries can no longer land on different backends). The
    // request-scoped reuse shortcut lives in withTenantTransaction too, so
    // delegating keeps one code path. Multi-statement callbacks are now atomic
    // (a strict improvement; standalone withTenant callbacks are single-statement
    // CRUD or already-safe-to-atomize). All ~400 call sites are unchanged.
    return this.withTenantTransaction(tenantId, fn);
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
    // U2b-2: SET LOCAL ROLE inside a transaction (PgBouncer transaction-pooling
    // safe — the role and the sweep queries can no longer land on different
    // backends), mirroring withTenantTransaction. applyCrossTenantRole is a
    // graceful no-op when the flag is off or the role is unprovisioned, so this
    // is byte-equivalent to withClient in those cases (just wrapped in a txn).
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await applyCrossTenantRole(client, { transactional: true });
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
      // Belt-and-suspenders: SET LOCAL ROLE auto-resets at COMMIT/ROLLBACK, but
      // clear explicitly too so a broken/edge state can't leak the role.
      await clearTenantContext(client);
      client.release();
    }
  }
}
