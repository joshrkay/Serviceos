import { Pool, PoolConfig } from 'pg';

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
    config = {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'serviceos_dev',
      user: process.env.DB_USER || 'serviceos',
      password: process.env.DB_PASSWORD || '',
      ssl: false,
      max: parseInt(process.env.DB_MAX_CONNECTIONS || '10', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };
  }

  return new Pool(config);
}
