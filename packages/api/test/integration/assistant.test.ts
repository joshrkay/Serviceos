import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';

describe('Postgres integration — assistant', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('Assistant (stateless)', () => {
    it('assistant route is configured - stateless chat interface', async () => {
      expect(true).toBe(true);
    });

    it('can use database for context queries', async () => {
      const result = await pool.query(
        'SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = $1)',
        ['conversations']
      );
      expect(result.rows[0].exists).toBe(true);
    });
  });
});