import { Pool, PoolClient, QueryResultRow } from 'pg';
import { DatabaseClient, DatabaseConfig, QueryResult } from './connection';
import { setTenantContext } from './schema';

/**
 * Concrete Postgres implementation of DatabaseClient using node-postgres (pg).
 *
 * Usage:
 *   const client = new PgDatabaseClient(config);
 *   await client.setTenantContext(tenantId);   // sets app.current_tenant_id for RLS
 *   const result = await client.query<UserRow>('SELECT * FROM users');
 *   await client.end();
 */
export class PgDatabaseClient implements DatabaseClient {
  private pool: Pool;

  constructor(config: DatabaseConfig) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : false,
      max: config.maxConnections ?? 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    this.pool.on('error', (err) => {
      process.stderr.write(`pg pool error: ${err.message}\n`);
    });
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await this.pool.query<QueryResultRow>(sql, params);
    return {
      rows: result.rows as T[],
      rowCount: result.rowCount ?? 0,
    };
  }

  /**
   * Set the RLS tenant context for the current transaction.
   * Must be called inside a transaction before any tenant-scoped queries.
   */
  async setTenantContext(tenantId: string): Promise<void> {
    await this.pool.query(setTenantContext(tenantId));
  }

  /**
   * Run a block of queries within a single connection (for transactions).
   */
  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  /**
   * Run a block within an explicit transaction — auto-commits or rolls back.
   */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Singleton pool for the API process.
 * Import and use this rather than creating a new client per request.
 */
let _client: PgDatabaseClient | null = null;

export function getDbClient(config: DatabaseConfig): PgDatabaseClient {
  if (!_client) {
    _client = new PgDatabaseClient(config);
  }
  return _client;
}
