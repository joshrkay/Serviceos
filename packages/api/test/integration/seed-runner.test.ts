/**
 * Postgres integration — the demo seeder writes a real, isolated, day-distinct
 * dataset. Proves runSeed inserts the full customer → location → job → estimate
 * → appointment chain through the production repositories (so every row passes
 * validation + RLS), that tenants don't bleed into each other, and that every
 * appointment lands on its own calendar day. The unit test (test/seed/
 * seed-plan.test.ts) proves the default plan is 200 over 10 tenants; this proves
 * the same machinery actually persists, at a smaller size for CI speed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import { runSeed } from '../../src/seed/seed-runner';

describe('Postgres integration — demo seeder', () => {
  let pool: Pool;
  let tenantIds: string[];

  beforeAll(async () => {
    pool = await getSharedTestDb();
    const result = await runSeed(pool, {
      tenantCount: 3,
      customersPerTenant: 5,
      startDate: new Date('2026-08-01T00:00:00Z'),
    });
    tenantIds = result.tenantIds;
    // The runner reports exactly what it inserted.
    expect(result).toMatchObject({ customers: 15, estimates: 15, appointments: 15 });
    expect(tenantIds).toHaveLength(3);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function countFor(tenantId: string, table: 'customers' | 'estimates' | 'appointments') {
    const client = await pool.connect();
    try {
      await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenantId]);
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
        [tenantId],
      );
      return rows[0].n as number;
    } finally {
      await client.query('RESET app.current_tenant_id').catch(() => undefined);
      client.release();
    }
  }

  it('persists 5 customers, 5 estimates, and 5 appointments per tenant', async () => {
    for (const tenantId of tenantIds) {
      expect(await countFor(tenantId, 'customers')).toBe(5);
      expect(await countFor(tenantId, 'estimates')).toBe(5);
      expect(await countFor(tenantId, 'appointments')).toBe(5);
    }
  });

  it('keeps tenants isolated — no tenant sees another tenant rows under RLS', async () => {
    // Cross-check: scoped to tenant A, a count filtered by tenant B's id is 0.
    const [a, b] = tenantIds;
    const client = await pool.connect();
    try {
      await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [a]);
      const { rows } = await client.query(
        'SELECT COUNT(*)::int AS n FROM customers WHERE tenant_id = $1',
        [b],
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await client.query('RESET app.current_tenant_id').catch(() => undefined);
      client.release();
    }
  });

  it('schedules every appointment on its own calendar day (separate days/times)', async () => {
    const allDays: string[] = [];
    for (const tenantId of tenantIds) {
      const client = await pool.connect();
      try {
        await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenantId]);
        const { rows } = await client.query<{ scheduled_start: Date }>(
          'SELECT scheduled_start FROM appointments WHERE tenant_id = $1',
          [tenantId],
        );
        for (const r of rows) {
          allDays.push(new Date(r.scheduled_start).toISOString().slice(0, 10));
        }
      } finally {
        await client.query('RESET app.current_tenant_id').catch(() => undefined);
        client.release();
      }
    }
    expect(allDays).toHaveLength(15);
    // Across all three tenants, no two appointments share a day.
    expect(new Set(allDays).size).toBe(15);
  });
});
