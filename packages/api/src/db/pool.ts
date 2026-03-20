import { Pool, PoolConfig } from 'pg';

const isProd = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod';

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

  return pool;
}
