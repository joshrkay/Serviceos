import { Pool, PoolClient } from 'pg';
import { setTenantContext } from './schema';

/**
 * Base class for all Postgres-backed repositories.
 * Provides tenant-scoped query execution via RLS context setting.
 */
export class PgBaseRepository {
  constructor(protected readonly pool: Pool) {}

  /**
   * Execute a callback within a tenant-scoped database context.
   * Sets `app.current_tenant_id` so RLS policies filter automatically.
   */
  protected async withTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
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
