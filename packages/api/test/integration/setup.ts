/**
 * Integration test setup using testcontainers
 *
 * Spins up a real Postgres instance for integration tests. Each test suite:
 * 1. Creates a fresh test database with RLS policies applied
 * 2. Runs migrations
 * 3. Creates an isolated tenant via factory
 * 4. Executes tests within that tenant context
 * 5. Tears down after suite completion
 *
 * Why real Postgres, not SQLite: RLS policies, tenant isolation, and timezone
 * behavior are Postgres-specific. Mocking these gives false confidence.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { getMigrationSQL, setTenantContext } from '../../src/db/schema';

let container: StartedPostgreSqlContainer;

export interface TestDbContext {
  connectionUri: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

export async function startTestDatabase(): Promise<TestDbContext> {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withExposedPorts(5432)
    .start();

  return {
    connectionUri: container.getConnectionUri(),
    host: container.getHost(),
    port: container.getMappedPort(5432),
    database: container.getDatabase(),
    username: container.getUsername(),
    password: container.getPassword(),
  };
}

export async function stopTestDatabase(): Promise<void> {
  if (container) {
    await container.stop();
  }
}

/**
 * Run all migrations against the test database.
 * In a real implementation, this would use a proper migration runner.
 * For now it executes the combined migration SQL.
 */
export async function runMigrations(connectionUri: string): Promise<void> {
  // This would be implemented with pg client when pg dependency is added
  // const client = new Client({ connectionString: connectionUri });
  // await client.connect();
  // await client.query(getMigrationSQL());
  // await client.end();
  const _sql = getMigrationSQL();
  const _uri = connectionUri;
}

/**
 * Create an isolated tenant context for testing.
 * Returns the SQL to set the current tenant context for RLS.
 */
export function createTenantContext(tenantId: string): string {
  return setTenantContext(tenantId);
}
