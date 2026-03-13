export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  maxConnections?: number;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface DatabaseClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  setTenantContext(tenantId: string): Promise<void>;
  end(): Promise<void>;
}

export function createDatabaseConfig(env: string): DatabaseConfig {
  // Railway (and most PaaS) inject DATABASE_URL — prefer it over individual vars
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    return {
      host: url.hostname,
      port: parseInt(url.port || '5432', 10),
      database: url.pathname.replace(/^\//, ''),
      user: url.username,
      password: decodeURIComponent(url.password),
      ssl: url.searchParams.get('sslmode') !== 'disable',
      maxConnections: env === 'prod' ? 50 : env === 'staging' ? 20 : 10,
    };
  }

  const configs: Record<string, DatabaseConfig> = {
    dev: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'serviceos_dev',
      user: process.env.DB_USER || 'serviceos',
      password: process.env.DB_PASSWORD || '',
      ssl: false,
      maxConnections: 10,
    },
    staging: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'serviceos_staging',
      user: process.env.DB_USER || 'serviceos',
      password: process.env.DB_PASSWORD || '',
      ssl: true,
      maxConnections: 20,
    },
    prod: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'serviceos_prod',
      user: process.env.DB_USER || 'serviceos',
      password: process.env.DB_PASSWORD || '',
      ssl: true,
      maxConnections: 50,
    },
  };

  const config = configs[env];
  if (!config) {
    throw new Error(`Unknown database environment: ${env}`);
  }
  return config;
}
