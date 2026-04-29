import { Pool, PoolClient } from 'pg';
import { setTenantContext } from './schema';
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
   * same transaction with the same `SET LOCAL` GUC. When invoked
   * outside that scope (workers, public flows, tests), we fall back to
   * the original per-call connection acquisition. The fallback uses
   * the existing `setTenantContext` helper — preserving exact pre-PR
   * behavior so non-request callers see no functional change.
   */
  protected async withTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const ctx = tenantContextStore.getStore();
    if (ctx && ctx.tenantId === tenantId) {
      // Request-scoped client — already inside a transaction with
      // app.current_tenant_id set LOCAL. Don't re-set, don't re-connect,
      // don't release (the middleware owns the lifecycle).
      return fn(ctx.client);
    }
    const client = await this.pool.connect();
    try {
      await client.query(setTenantContext(tenantId));
      return await fn(client);
    } finally {
      client.release();
    }
  }

  /**
   * Execute a callback within a tenant-scoped transaction.
   * Rolls back on error.
   */
  protected async withTenantTransaction<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(setTenantContext(tenantId));
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
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
}
