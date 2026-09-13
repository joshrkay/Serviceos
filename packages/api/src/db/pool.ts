import { Pool, PoolConfig } from 'pg';

const isProd = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod';

/**
 * #1090 — keep a server-side connection kill off `uncaughtException`.
 *
 * `pool.on('error')` below only covers clients that are IDLE IN THE POOL:
 * pg-pool attaches its `idleListener` on release and REMOVES it again on
 * checkout (`pg-pool/index.js` `_acquireClient`: `client.removeListener(
 * 'error', idleListener)`). So for the whole time a repository/worker holds a
 * client, the client has no `'error'` listener at all.
 *
 * That matters because a connection the SERVER kills does not surface as a
 * rejected query promise. `pg/lib/client.js` `_handleErrorMessage` routes a
 * backend ErrorResponse to the active query — but a transaction sitting idle
 * (awaiting a slow upstream, or between two statements) has no active query,
 * so it falls through to `_handleErrorEvent`, which does
 * `this.emit('error', err)`. The socket close that follows emits a second one
 * ("Connection terminated unexpectedly"). With no listener, Node re-throws
 * both as `uncaughtException` — and index.ts treats that as FATAL and drains
 * the process. No `try/catch` around the caller's `await` can ever see it,
 * because the error is never delivered to a promise.
 *
 * Production hits this whenever Postgres terminates a held connection:
 * `idle_in_transaction_session_timeout` (middleware/tenant-context.ts sets it
 * LOCAL on every request transaction, and managed providers set it
 * server-side), an admin terminate, a failover, or a network reset.
 *
 * The guard attaches ONE permanent listener per client, on `'connect'` (which
 * pg-pool emits once per newly created client), so the event always has a
 * handler whichever side of a checkout it arrives on. It changes nothing else:
 * pg still marks the client unqueryable, still rejects any in-flight query,
 * and still discards the client on release (`_release` removes a client whose
 * `_queryable` is false), so callers keep seeing ordinary, catchable errors.
 */
function guardClientErrors(pool: Pool, label: string): void {
  pool.on('connect', (client) => {
    client.on('error', (err: Error) => {
      process.stderr.write(`pg ${label} client connection error: ${err.message}\n`);
    });
  });
}

export function createPool(): Pool {
  const databaseUrl = process.env.DATABASE_URL;

  let config: PoolConfig;

  if (databaseUrl) {
    config = {
      connectionString: databaseUrl,
      ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: parseInt(process.env.DB_MAX_CONNECTIONS || '20', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };
  } else {
    // In production, these values MUST come from environment variables.
    // Dev defaults are only applied in non-production environments.
    config = {
      host: process.env.DB_HOST || (isProd ? undefined : 'localhost'),
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || (isProd ? undefined : 'serviceos_dev'),
      user: process.env.DB_USER || (isProd ? undefined : 'serviceos'),
      password: process.env.DB_PASSWORD || (isProd ? undefined : ''),
      ssl: isProd ? { rejectUnauthorized: false } : false,
      max: parseInt(process.env.DB_MAX_CONNECTIONS || '10', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };
  }

  const pool = new Pool(config);

  // Prevent unhandled 'error' events on idle clients from crashing the process.
  pool.on('error', (err) => {
    process.stderr.write(`pg pool background error: ${err.message}\n`);
  });
  // …and the same for clients that are CHECKED OUT, which the handler above
  // does not cover (#1090 — see guardClientErrors).
  guardClientErrors(pool, 'pool');

  return pool;
}

/**
 * Direct (session-mode) pool for Postgres state that is UNSAFE under PgBouncer
 * transaction-mode pooling, because it relies on a stable backend across
 * statements: SESSION advisory locks (leader election in `app.ts` `runAsLeader`,
 * and `PgIdempotencyLockProvider`) and `LISTEN`/`NOTIFY` (`integrations/credentials.ts`).
 *
 * `DATABASE_DIRECT_URL` is a DSN that connects straight to Postgres, bypassing
 * PgBouncer. Returns `null` when it is unset — the caller then reuses the main
 * pool, which is correct for dev / any deployment without PgBouncer (identical
 * behavior to before this split). In production `DATABASE_URL` points at
 * PgBouncer (transaction mode) and `DATABASE_DIRECT_URL` at Postgres directly.
 */
export function createDirectPool(): Pool | null {
  const url = process.env.DATABASE_DIRECT_URL;
  if (!url) return null;

  const pool = new Pool({
    connectionString: url,
    ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
    // Small — only the session-lock holders and the LISTEN client use it.
    max: parseInt(process.env.DB_DIRECT_MAX_CONNECTIONS || '10', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  pool.on('error', (err) => {
    process.stderr.write(`pg direct pool background error: ${err.message}\n`);
  });
  // The direct pool is exactly where a held connection lives longest (session
  // advisory locks across a whole sweep, LISTEN/NOTIFY), so it needs the
  // checked-out guard at least as much as the main pool (#1090).
  guardClientErrors(pool, 'direct pool');
  return pool;
}
