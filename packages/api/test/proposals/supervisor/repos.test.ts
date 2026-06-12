/**
 * Rivet P2 F-1 — supervisor repos: policies (versioned rule sets) and
 * tenant budget counters (fixed UTC windows).
 *
 * In-memory implementations are tested behaviorally; the Pg
 * implementations are pinned at the SQL-shape level with a mocked pool
 * (explicit tenant predicates, ON CONFLICT accumulate). Real-column
 * proof lives in test/integration/tenant-isolation.leak.test.ts
 * (Docker-gated, runs in PR CI).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import {
  InMemorySupervisorPolicyRepository,
  PgSupervisorPolicyRepository,
} from '../../../src/proposals/supervisor/policies-repo';
import {
  AUTO_APPROVALS_COUNTER_KEY,
  DAILY_SPEND_COUNTER_KEY,
  InMemoryTenantBudgetCounterRepository,
  PgTenantBudgetCounterRepository,
  utcDayWindowStart,
  utcHourWindowStart,
} from '../../../src/proposals/supervisor/budget-counters-repo';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

describe('InMemorySupervisorPolicyRepository', () => {
  it('getActive returns null when no policy exists (default permissive)', async () => {
    const repo = new InMemorySupervisorPolicyRepository();
    expect(await repo.getActive(TENANT_A)).toBeNull();
  });

  it('createVersion assigns monotonically increasing versions, inactive by default', async () => {
    const repo = new InMemorySupervisorPolicyRepository();
    const v1 = await repo.createVersion(TENANT_A, { perProposalCapCents: 100 }, 'admin');
    const v2 = await repo.createVersion(TENANT_A, { perProposalCapCents: 200 }, 'admin');
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v1.active).toBe(false);
    expect(v2.active).toBe(false);
    expect(await repo.getActive(TENANT_A)).toBeNull();
  });

  it('activate flips the chosen version on and every sibling off', async () => {
    const repo = new InMemorySupervisorPolicyRepository();
    await repo.createVersion(TENANT_A, { perProposalCapCents: 100 });
    await repo.createVersion(TENANT_A, { perProposalCapCents: 200 });
    const activated = await repo.activate(TENANT_A, 1);
    expect(activated?.version).toBe(1);
    expect((await repo.getActive(TENANT_A))?.rules).toEqual({ perProposalCapCents: 100 });

    await repo.activate(TENANT_A, 2);
    const active = await repo.getActive(TENANT_A);
    expect(active?.version).toBe(2);
  });

  it('activate of a missing version returns null and changes nothing', async () => {
    const repo = new InMemorySupervisorPolicyRepository();
    await repo.createVersion(TENANT_A, {});
    await repo.activate(TENANT_A, 1);
    expect(await repo.activate(TENANT_A, 99)).toBeNull();
    expect((await repo.getActive(TENANT_A))?.version).toBe(1);
  });

  it('versions and activation are tenant-scoped', async () => {
    const repo = new InMemorySupervisorPolicyRepository();
    await repo.createVersion(TENANT_A, { dailySpendCapCents: 1 });
    const b1 = await repo.createVersion(TENANT_B, { dailySpendCapCents: 2 });
    expect(b1.version).toBe(1); // independent version sequence per tenant
    await repo.activate(TENANT_A, 1);
    expect(await repo.getActive(TENANT_B)).toBeNull();
    expect((await repo.getActive(TENANT_A))?.rules).toEqual({ dailySpendCapCents: 1 });
  });
});

describe('InMemoryTenantBudgetCounterRepository', () => {
  const window = new Date('2026-06-11T00:00:00.000Z');

  it('read returns 0 for an absent counter', async () => {
    const repo = new InMemoryTenantBudgetCounterRepository();
    expect(await repo.read(TENANT_A, DAILY_SPEND_COUNTER_KEY, window)).toBe(0);
  });

  it('increment accumulates within the same (tenant, key, window)', async () => {
    const repo = new InMemoryTenantBudgetCounterRepository();
    await repo.increment(TENANT_A, DAILY_SPEND_COUNTER_KEY, window, 100);
    await repo.increment(TENANT_A, DAILY_SPEND_COUNTER_KEY, window, 250);
    expect(await repo.read(TENANT_A, DAILY_SPEND_COUNTER_KEY, window)).toBe(350);
  });

  it('windows, keys, and tenants are independent', async () => {
    const repo = new InMemoryTenantBudgetCounterRepository();
    const otherWindow = new Date('2026-06-12T00:00:00.000Z');
    await repo.increment(TENANT_A, DAILY_SPEND_COUNTER_KEY, window, 100);
    await repo.increment(TENANT_A, AUTO_APPROVALS_COUNTER_KEY, window, 1);
    await repo.increment(TENANT_B, DAILY_SPEND_COUNTER_KEY, window, 7);
    expect(await repo.read(TENANT_A, DAILY_SPEND_COUNTER_KEY, otherWindow)).toBe(0);
    expect(await repo.read(TENANT_A, AUTO_APPROVALS_COUNTER_KEY, window)).toBe(1);
    expect(await repo.read(TENANT_B, DAILY_SPEND_COUNTER_KEY, window)).toBe(7);
    expect(await repo.read(TENANT_A, DAILY_SPEND_COUNTER_KEY, window)).toBe(100);
  });
});

describe('UTC window truncation (v1 — documented as UTC, not tenant-local)', () => {
  it('utcDayWindowStart truncates to 00:00:00.000Z', () => {
    expect(utcDayWindowStart(new Date('2026-06-11T17:45:33.123Z')).toISOString()).toBe(
      '2026-06-11T00:00:00.000Z',
    );
    expect(utcDayWindowStart(new Date('2026-06-11T00:00:00.000Z')).toISOString()).toBe(
      '2026-06-11T00:00:00.000Z',
    );
  });

  it('utcHourWindowStart truncates to the top of the UTC hour', () => {
    expect(utcHourWindowStart(new Date('2026-06-11T17:45:33.123Z')).toISOString()).toBe(
      '2026-06-11T17:00:00.000Z',
    );
    expect(utcHourWindowStart(new Date('2026-06-11T23:59:59.999Z')).toISOString()).toBe(
      '2026-06-11T23:00:00.000Z',
    );
  });
});

// ── Pg SQL-shape pins (mock pool; real columns proven in the leak suite) ──

interface Recorded {
  sql: string;
  params: unknown[] | undefined;
}

function mockPool(rowsBySql: (sql: string) => unknown[] = () => []) {
  const calls: Recorded[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: rowsBySql(sql), rowCount: rowsBySql(sql).length } as unknown as QueryResult;
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, calls };
}

describe('PgSupervisorPolicyRepository — SQL shape', () => {
  it('getActive filters by tenant_id AND active', async () => {
    const { pool, calls } = mockPool();
    const repo = new PgSupervisorPolicyRepository(pool);
    expect(await repo.getActive(TENANT_A)).toBeNull();
    const q = calls.find((c) => c.sql.includes('FROM supervisor_policies'));
    expect(q).toBeDefined();
    expect(q!.sql).toMatch(/tenant_id = \$1/);
    expect(q!.sql).toMatch(/active = true/i);
    expect(q!.params).toEqual([TENANT_A]);
  });

  it('createVersion inserts with a tenant-scoped next version', async () => {
    const row = {
      id: 'p-1',
      tenant_id: TENANT_A,
      version: 1,
      active: false,
      rules: { perProposalCapCents: 100 },
      created_by: 'admin',
      created_at: new Date().toISOString(),
    };
    const { pool, calls } = mockPool((sql) => (sql.includes('INSERT INTO') ? [row] : []));
    const repo = new PgSupervisorPolicyRepository(pool);
    const created = await repo.createVersion(TENANT_A, { perProposalCapCents: 100 }, 'admin');
    expect(created.version).toBe(1);
    expect(created.rules).toEqual({ perProposalCapCents: 100 });
    const q = calls.find((c) => c.sql.includes('INSERT INTO supervisor_policies'));
    expect(q).toBeDefined();
    expect(q!.sql).toMatch(/COALESCE\(MAX\(version\), 0\) \+ 1/);
    expect(q!.sql).toMatch(/WHERE tenant_id = \$1/);
  });

  it('activate flips the target on and siblings off inside one transaction', async () => {
    const row = {
      id: 'p-1',
      tenant_id: TENANT_A,
      version: 2,
      active: true,
      rules: {},
      created_by: null,
      created_at: new Date().toISOString(),
    };
    const { pool, calls } = mockPool((sql) =>
      sql.includes('active = true') && sql.includes('RETURNING') ? [row] : [],
    );
    const repo = new PgSupervisorPolicyRepository(pool);
    const activated = await repo.activate(TENANT_A, 2);
    expect(activated?.version).toBe(2);
    const sqls = calls.map((c) => c.sql);
    const offIdx = sqls.findIndex((s) => s.includes('SET active = false'));
    const onIdx = sqls.findIndex((s) => s.includes('SET active = true'));
    const beginIdx = sqls.findIndex((s) => s === 'BEGIN');
    const commitIdx = sqls.findIndex((s) => s === 'COMMIT');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    // Target is activated first (so a missing version returns null with
    // NO state change), then siblings are deactivated — both inside the
    // same BEGIN/COMMIT so readers never observe two active rows.
    expect(onIdx).toBeGreaterThan(beginIdx);
    expect(offIdx).toBeGreaterThan(onIdx);
    expect(commitIdx).toBeGreaterThan(offIdx);
    expect(calls[offIdx].sql).toMatch(/tenant_id = \$1/);
    expect(calls[onIdx].sql).toMatch(/tenant_id = \$1/);
    expect(calls[onIdx].params).toEqual([TENANT_A, 2]);
  });
});

describe('PgTenantBudgetCounterRepository — SQL shape', () => {
  const window = new Date('2026-06-11T00:00:00.000Z');

  it('increment is INSERT .. ON CONFLICT accumulate', async () => {
    const { pool, calls } = mockPool();
    const repo = new PgTenantBudgetCounterRepository(pool);
    await repo.increment(TENANT_A, DAILY_SPEND_COUNTER_KEY, window, 450);
    const q = calls.find((c) => c.sql.includes('INSERT INTO tenant_budget_counters'));
    expect(q).toBeDefined();
    expect(q!.sql).toMatch(/ON CONFLICT \(tenant_id, counter_key, window_start\)/);
    expect(q!.sql).toMatch(/value = tenant_budget_counters\.value \+ EXCLUDED\.value/);
    expect(q!.params).toEqual([TENANT_A, DAILY_SPEND_COUNTER_KEY, window, 450]);
  });

  it('read selects by the full composite key and coerces BIGINT-as-string', async () => {
    const { pool, calls } = mockPool((sql) =>
      sql.includes('SELECT value') ? [{ value: '350' }] : [],
    );
    const repo = new PgTenantBudgetCounterRepository(pool);
    const value = await repo.read(TENANT_A, AUTO_APPROVALS_COUNTER_KEY, window);
    expect(value).toBe(350);
    const q = calls.find((c) => c.sql.includes('SELECT value'));
    expect(q!.sql).toMatch(/tenant_id = \$1 AND counter_key = \$2 AND window_start = \$3/);
  });

  it('read returns 0 when no row exists', async () => {
    const { pool } = mockPool();
    const repo = new PgTenantBudgetCounterRepository(pool);
    expect(await repo.read(TENANT_A, AUTO_APPROVALS_COUNTER_KEY, window)).toBe(0);
  });
});
