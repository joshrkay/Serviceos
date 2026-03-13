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
  const configs: Record<string, DatabaseConfig> = {
    dev: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: 'serviceos_dev',
      user: process.env.DB_USER || 'serviceos',
      password: process.env.DB_PASSWORD || '',
      ssl: false,
      maxConnections: 10,
    },
    staging: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: 'serviceos_staging',
      user: process.env.DB_USER || 'serviceos',
      password: process.env.DB_PASSWORD || '',
      ssl: true,
      maxConnections: 20,
    },
    prod: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: 'serviceos_prod',
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
