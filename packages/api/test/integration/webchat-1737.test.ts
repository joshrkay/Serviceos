/**
 * #1737 — web chat config + daily usage at real Postgres: the real columns,
 * RLS isolation, the atomic daily cap, and the token/kill-switch writes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, ensureRlsRuntimeRole, RLS_APP_ROLE } from './shared';
import { PgWebchatConfigRepository, tenantIdFromToken } from '../../src/webchat/webchat-config';
import { PgWebchatUsageRepository } from '../../src/webchat/webchat-usage';

describe('Postgres integration — web chat (#1737)', () => {
  let pool: Pool;
  let configRepo: PgWebchatConfigRepository;
  let usageRepo: PgWebchatUsageRepository;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    configRepo = new PgWebchatConfigRepository(pool);
    usageRepo = new PgWebchatUsageRepository(pool);
    tenantA = (await createTestTenant(pool)).tenantId;
    tenantB = (await createTestTenant(pool)).tenantId;
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('has no row (widget off) until first written; the first write is off with a token for the tenant', async () => {
    expect(await configRepo.get(tenantA)).toBeNull();
    const created = await configRepo.upsert(tenantA, { allowedOrigins: ['https://a.example.com'] });
    expect(created.enabled).toBe(false);
    expect(created.killedAt).toBeNull();
    expect(created.dailyTurnCap).toBe(200);
    expect(created.dailyCostCapCents).toBe(500);
    expect(tenantIdFromToken(created.embedToken)).toBe(tenantA);
    expect(created.allowedOrigins).toEqual(['https://a.example.com']);
  });

  it('patches only what was sent, keeps the token, and sets/clears the kill switch', async () => {
    const before = (await configRepo.get(tenantA))!;
    const on = await configRepo.upsert(tenantA, { enabled: true, dailyTurnCap: 7, killed: true });
    expect(on).toMatchObject({ enabled: true, dailyTurnCap: 7, embedToken: before.embedToken });
    expect(on.killedAt).toBeInstanceOf(Date);
    expect(on.allowedOrigins).toEqual(['https://a.example.com']);
    expect((await configRepo.upsert(tenantA, { killed: false })).killedAt).toBeNull();
  });

  it('rotateToken replaces the token', async () => {
    const before = (await configRepo.get(tenantA))!;
    const after = await configRepo.rotateToken(tenantA);
    expect(after.embedToken).not.toBe(before.embedToken);
    expect(tenantIdFromToken(after.embedToken)).toBe(tenantA);
  });

  it("one tenant cannot read another's config or usage (RLS)", async () => {
    await configRepo.upsert(tenantB, { enabled: true });
    expect((await configRepo.get(tenantA))!.tenantId).toBe(tenantA);
    const client = await pool.connect();
    try {
      await ensureRlsRuntimeRole(pool);
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${RLS_APP_ROLE}`);
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      const rows = await client.query('SELECT tenant_id FROM webchat_config');
      expect(rows.rows.map((r) => r.tenant_id)).toEqual([tenantA]);
      const usage = await client.query('SELECT tenant_id FROM webchat_usage_daily');
      expect(usage.rows.every((r) => r.tenant_id === tenantA)).toBe(true);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('enforces the daily turn cap atomically, per tenant and per day', async () => {
    const caps = { turnCap: 3, costCapCents: 100 };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => usageRepo.reserveTurn(tenantA, '2026-10-22', caps)),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    expect((await usageRepo.get(tenantA, '2026-10-22')).turns).toBe(3);
    expect(await usageRepo.reserveTurn(tenantB, '2026-10-22', caps)).toBe(true);
    expect(await usageRepo.reserveTurn(tenantA, '2026-10-23', caps)).toBe(true);
  });

  it('refuses a turn once the daily cost (integer cents) is at the cap, and accumulates cost', async () => {
    const day = '2026-11-01';
    const caps = { turnCap: 100, costCapCents: 10 };
    expect(await usageRepo.reserveTurn(tenantA, day, caps)).toBe(true);
    await usageRepo.addCost(tenantA, day, 4);
    await usageRepo.addCost(tenantA, day, 6);
    expect(await usageRepo.get(tenantA, day)).toEqual({ turns: 1, costCents: 10 });
    expect(await usageRepo.reserveTurn(tenantA, day, caps)).toBe(false);
    expect((await usageRepo.get(tenantA, day)).turns).toBe(1);
  });

  it('cost recorded before any turn still creates the day row', async () => {
    await usageRepo.addCost(tenantB, '2026-11-02', 3);
    expect(await usageRepo.get(tenantB, '2026-11-02')).toEqual({ turns: 0, costCents: 3 });
  });
});
