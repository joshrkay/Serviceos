import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, PoolClient } from 'pg';
import { getMigrationSQL } from '../../src/db/schema';

let sharedContainer: StartedPostgreSqlContainer | null = null;
let sharedPool: Pool | null = null;

export async function getSharedTestDb(): Promise<Pool> {
  if (!sharedContainer || !sharedPool) {
    const image = process.env.POSTGRES_IMAGE || 'pgvector/pgvector:pg16';
    sharedContainer = await new PostgreSqlContainer(image)
      .withDatabase('serviceos_test')
      .start();

    sharedPool = new Pool({
      connectionString: sharedContainer.getConnectionUri(),
    });

    await sharedPool.query('SET lock_timeout = \'5s\'');
    await sharedPool.query('SET statement_timeout = \'25s\'');
    await sharedPool.query(getMigrationSQL());
  }
  return sharedPool;
}

export async function closeSharedTestDb(): Promise<void> {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = null;
  }
  if (sharedContainer) {
    await sharedContainer.stop();
    sharedContainer = null;
  }
}

export interface TestTenant {
  tenantId: string;
  userId: string;
}

export async function createTestTenant(pool: Pool): Promise<TestTenant> {
  const tenantId = crypto.randomUUID();
  const userId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO tenants (id, owner_id, owner_email, name) VALUES ($1, $2, $3, $4)`,
    [tenantId, userId, 'test@example.com', 'Test Tenant']
  );

  await pool.query(
    `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, $5)`,
    [userId, tenantId, userId, 'test@example.com', 'owner']
  );

  return { tenantId, userId };
}

export async function setTenantContext(pool: Pool, tenantId: string): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
  return client;
}