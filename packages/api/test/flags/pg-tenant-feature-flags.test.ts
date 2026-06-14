/**
 * Unit tests for PgTenantFeatureFlagRepository.
 *
 * Mirrors pg-note.test.ts: mocked pool, no Docker.
 * Verifies resolution order, cache TTL, cache bust on setTenantFlag, upsert shape.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { PgTenantFeatureFlagRepository } from '../../src/flags/pg-tenant-feature-flags';
import type { FeatureFlag, FeatureFlagRepository } from '../../src/flags/feature-flags';

type CapturedCall = { sql: string; params: unknown[] };
type Responder = (sql: string, params: unknown[]) => { rows: Record<string, unknown>[]; rowCount?: number };

function makeMockPool(responder: Responder) {
  const calls: CapturedCall[] = [];
  let releaseCount = 0;
  const client: Partial<PoolClient> = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const res = responder(sql, params ?? []);
      return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length } as unknown as QueryResult;
    }) as unknown as PoolClient['query'],
    release: vi.fn(() => {
      releaseCount += 1;
    }) as unknown as PoolClient['release'],
  };
  const pool: Partial<Pool> = {
    connect: vi.fn(async () => client as PoolClient) as unknown as Pool['connect'],
  };
  return { pool: pool as Pool, calls, getReleaseCount: () => releaseCount };
}

const TENANT = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const isContext = (sql: string) => sql.includes('app.current_tenant_id');

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal FeatureFlagRepository stub returning a single flag (or null). */
function makePlatformRepo(flag: FeatureFlag | null): FeatureFlagRepository {
  return {
    list: async () => (flag ? [flag] : []),
    get: async (name: string) => (flag && flag.name === name ? flag : null),
    upsert: async (f: FeatureFlag) => f,
    delete: async () => false,
  };
}

/** Simulates a tenant override row from tenant_feature_flags */
function tenantOverrideRow(enabled: boolean) {
  return [
    {
      tenant_id: TENANT,
      flag_key: 'my-flag',
      enabled,
      updated_by: null,
      updated_at: new Date().toISOString(),
    },
  ];
}

/**
 * Build a mock pool that handles tenant-scoped queries only (no platform repo).
 *  - responds to SET app.current_tenant_id with []
 *  - responds to RESET app.current_tenant_id with []
 *  - responds to tenant_feature_flags SELECT with tenantRows
 *  - responds to upsert with upsertRows
 */
function makeTenantPool(opts: {
  tenantRows: Record<string, unknown>[];
  upsertRows?: Record<string, unknown>[];
}) {
  return makeMockPool((sql) => {
    if (isContext(sql) || sql.includes('RESET')) return { rows: [] };
    if (sql.includes('tenant_feature_flags') && sql.includes('SELECT')) {
      return { rows: opts.tenantRows };
    }
    if (sql.includes('tenant_feature_flags') && sql.includes('INSERT')) {
      return { rows: opts.upsertRows ?? [] };
    }
    return { rows: [] };
  });
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('PgTenantFeatureFlagRepository.isEnabledForTenant', () => {
  it('RV-001-01: tenant override true beats platform false', async () => {
    const { pool } = makeTenantPool({ tenantRows: tenantOverrideRow(true) });
    const platformRepo = makePlatformRepo({ name: 'my-flag', enabled: false });
    const repo = new PgTenantFeatureFlagRepository(pool, platformRepo);
    expect(await repo.isEnabledForTenant(TENANT, 'my-flag')).toBe(true);
  });

  it('RV-001-02: tenant override false beats platform true', async () => {
    const { pool } = makeTenantPool({ tenantRows: tenantOverrideRow(false) });
    const platformRepo = makePlatformRepo({ name: 'my-flag', enabled: true });
    const repo = new PgTenantFeatureFlagRepository(pool, platformRepo);
    expect(await repo.isEnabledForTenant(TENANT, 'my-flag')).toBe(false);
  });

  it('RV-001-03: missing tenant override falls back to platform true', async () => {
    const { pool } = makeTenantPool({ tenantRows: [] });
    const platformRepo = makePlatformRepo({ name: 'my-flag', enabled: true });
    const repo = new PgTenantFeatureFlagRepository(pool, platformRepo);
    expect(await repo.isEnabledForTenant(TENANT, 'my-flag')).toBe(true);
  });

  it('RV-001-04: missing tenant override falls back to platform false', async () => {
    const { pool } = makeTenantPool({ tenantRows: [] });
    const platformRepo = makePlatformRepo({ name: 'my-flag', enabled: false });
    const repo = new PgTenantFeatureFlagRepository(pool, platformRepo);
    expect(await repo.isEnabledForTenant(TENANT, 'my-flag')).toBe(false);
  });

  it('RV-001-05: missing both tenant override and platform flag returns false', async () => {
    const { pool } = makeTenantPool({ tenantRows: [] });
    const platformRepo = makePlatformRepo(null);
    const repo = new PgTenantFeatureFlagRepository(pool, platformRepo);
    expect(await repo.isEnabledForTenant(TENANT, 'unknown-flag')).toBe(false);
  });

  it('RV-001-06: sets tenant context for the tenant override query', async () => {
    const { pool, calls } = makeTenantPool({ tenantRows: tenantOverrideRow(true) });
    const platformRepo = makePlatformRepo(null);
    const repo = new PgTenantFeatureFlagRepository(pool, platformRepo);
    await repo.isEnabledForTenant(TENANT, 'my-flag');
    const contextCall = calls.find((c) => c.sql.includes('app.current_tenant_id'));
    expect(contextCall).toBeDefined();
    expect(contextCall!.sql).toContain(TENANT);
  });

  it('RV-001-07: uses composite PK lookup for tenant override read (tenant_id = $1 AND flag_key = $2)', async () => {
    const { pool, calls } = makeTenantPool({ tenantRows: tenantOverrideRow(true) });
    const platformRepo = makePlatformRepo(null);
    const repo = new PgTenantFeatureFlagRepository(pool, platformRepo);
    await repo.isEnabledForTenant(TENANT, 'my-flag');
    const selectCall = calls.find(
      (c) => c.sql.includes('tenant_feature_flags') && c.sql.includes('SELECT')
    );
    expect(selectCall).toBeDefined();
    // Must use parameterized query — no literal values interpolated
    expect(selectCall!.sql).not.toContain('my-flag');
    expect(selectCall!.sql).not.toContain(TENANT);
    // Must include both columns in WHERE (composite PK lookup)
    expect(selectCall!.sql).toMatch(/tenant_id\s*=\s*\$1/);
    expect(selectCall!.sql).toMatch(/flag_key\s*=\s*\$2/);
    // Both values must be parameters
    expect(selectCall!.params).toContain(TENANT);
    expect(selectCall!.params).toContain('my-flag');
  });

  it('RV-001-15: platform flag scoped to tenantIds:[A] is FALSE for tenant B via fallback', async () => {
    const { pool } = makeTenantPool({ tenantRows: [] }); // no tenant override
    const platformRepo = makePlatformRepo({
      name: 'my-flag',
      enabled: true,
      tenantIds: [TENANT], // only scoped to TENANT (A), not TENANT_B (B)
    });
    const repo = new PgTenantFeatureFlagRepository(pool, platformRepo);
    // tenant B should NOT get the flag even though platform enabled=true
    expect(await repo.isEnabledForTenant(TENANT_B, 'my-flag')).toBe(false);
  });

  it('RV-001-16: platform flag scoped to tenantIds:[A] is TRUE for tenant A via fallback', async () => {
    const { pool } = makeTenantPool({ tenantRows: [] }); // no tenant override
    const platformRepo = makePlatformRepo({
      name: 'my-flag',
      enabled: true,
      tenantIds: [TENANT],
    });
    const repo = new PgTenantFeatureFlagRepository(pool, platformRepo);
    expect(await repo.isEnabledForTenant(TENANT, 'my-flag')).toBe(true);
  });

  it('RV-001-17: platform flag scoped to environments is respected via fallback', async () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const { pool } = makeTenantPool({ tenantRows: [] });
      const platformRepo = makePlatformRepo({
        name: 'my-flag',
        enabled: true,
        environments: ['staging'], // not 'production'
      });
      const repo = new PgTenantFeatureFlagRepository(pool, platformRepo);
      expect(await repo.isEnabledForTenant(TENANT, 'my-flag')).toBe(false);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});

describe('PgTenantFeatureFlagRepository cache', () => {
  it('RV-001-08: cache returns stale value within TTL (no second DB call)', async () => {
    let callCount = 0;
    const { pool } = makeMockPool((sql) => {
      if (isContext(sql) || sql.includes('RESET')) return { rows: [] };
      if (sql.includes('tenant_feature_flags') && sql.includes('SELECT')) {
        callCount++;
        return { rows: tenantOverrideRow(true) };
      }
      return { rows: [] };
    });
    const platformRepo = makePlatformRepo(null);
    const repo = new PgTenantFeatureFlagRepository(pool, platformRepo);
    const first = await repo.isEnabledForTenant(TENANT, 'my-flag');
    const second = await repo.isEnabledForTenant(TENANT, 'my-flag');
    expect(first).toBe(true);
    expect(second).toBe(true);
    // Only one tenant_feature_flags SELECT: second call was served from cache
    expect(callCount).toBe(1);
  });

  it('RV-001-09: setTenantFlag busts cache immediately', async () => {
    let tenantSelectCount = 0;
    const { pool } = makeMockPool((sql) => {
      if (isContext(sql) || sql.includes('RESET')) return { rows: [] };
      if (sql.includes('tenant_feature_flags') && sql.includes('SELECT')) {
        tenantSelectCount++;
        return { rows: tenantOverrideRow(true) };
      }
      if (sql.includes('tenant_feature_flags') && sql.includes('INSERT')) {
        return {
          rows: [{ tenant_id: TENANT, flag_key: 'my-flag', enabled: false, updated_by: null, updated_at: new Date().toISOString() }],
        };
      }
      return { rows: [] };
    });
    const platformRepo = makePlatformRepo(null);
    const repo = new PgTenantFeatureFlagRepository(pool, platformRepo);

    // populate cache
    await repo.isEnabledForTenant(TENANT, 'my-flag');
    expect(tenantSelectCount).toBe(1);

    // bust via setTenantFlag
    await repo.setTenantFlag(TENANT, 'my-flag', false);

    // next read must re-query DB
    await repo.isEnabledForTenant(TENANT, 'my-flag');
    expect(tenantSelectCount).toBe(2);
  });

  it('RV-001-14: cache expires after 30 s — re-queries DB past TTL', async () => {
    vi.useFakeTimers();
    try {
      let callCount = 0;
      const { pool } = makeMockPool((sql) => {
        if (isContext(sql) || sql.includes('RESET')) return { rows: [] };
        if (sql.includes('tenant_feature_flags') && sql.includes('SELECT')) {
          callCount++;
          return { rows: tenantOverrideRow(true) };
        }
        return { rows: [] };
      });
      const platformRepo = makePlatformRepo(null);
      const repo = new PgTenantFeatureFlagRepository(pool, platformRepo);

      // Populate cache
      await repo.isEnabledForTenant(TENANT, 'my-flag');
      expect(callCount).toBe(1);

      // Within TTL — served from cache
      vi.advanceTimersByTime(29_999);
      await repo.isEnabledForTenant(TENANT, 'my-flag');
      expect(callCount).toBe(1);

      // Past TTL — must re-query DB
      vi.advanceTimersByTime(2);
      await repo.isEnabledForTenant(TENANT, 'my-flag');
      expect(callCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PgTenantFeatureFlagRepository.setTenantFlag', () => {
  it('RV-001-10: upsert uses ON CONFLICT clause', async () => {
    const { pool, calls } = makeTenantPool({
      tenantRows: [],
      upsertRows: [{ tenant_id: TENANT, flag_key: 'my-flag', enabled: true, updated_by: null, updated_at: new Date().toISOString() }],
    });
    const platformRepo = makePlatformRepo(null);
    const repo = new PgTenantFeatureFlagRepository(pool, platformRepo);
    await repo.setTenantFlag(TENANT, 'my-flag', true);
    const upsert = calls.find(
      (c) => c.sql.includes('tenant_feature_flags') && c.sql.includes('INSERT')
    );
    expect(upsert).toBeDefined();
    expect(upsert!.sql).toContain('ON CONFLICT');
    expect(upsert!.sql).toContain('DO UPDATE');
  });

  it('RV-001-11: upsert passes tenantId and flagKey as parameters (no interpolation)', async () => {
    const { pool, calls } = makeTenantPool({
      tenantRows: [],
      upsertRows: [{ tenant_id: TENANT, flag_key: 'my-flag', enabled: false, updated_by: null, updated_at: new Date().toISOString() }],
    });
    const platformRepo = makePlatformRepo(null);
    const repo = new PgTenantFeatureFlagRepository(pool, platformRepo);
    await repo.setTenantFlag(TENANT, 'my-flag', false);
    const upsert = calls.find(
      (c) => c.sql.includes('tenant_feature_flags') && c.sql.includes('INSERT')
    );
    expect(upsert!.sql).not.toContain(TENANT);
    expect(upsert!.sql).not.toContain('my-flag');
    expect(upsert!.params).toContain(TENANT);
    expect(upsert!.params).toContain('my-flag');
  });

  it('RV-001-12: upsert sets updated_by when provided', async () => {
    const UPDATED_BY = '33333333-3333-3333-3333-333333333333';
    const { pool, calls } = makeTenantPool({
      tenantRows: [],
      upsertRows: [{ tenant_id: TENANT, flag_key: 'feat', enabled: true, updated_by: UPDATED_BY, updated_at: new Date().toISOString() }],
    });
    const platformRepo = makePlatformRepo(null);
    const repo = new PgTenantFeatureFlagRepository(pool, platformRepo);
    await repo.setTenantFlag(TENANT, 'feat', true, UPDATED_BY);
    const upsert = calls.find(
      (c) => c.sql.includes('tenant_feature_flags') && c.sql.includes('INSERT')
    );
    expect(upsert!.params).toContain(UPDATED_BY);
  });

  it('RV-001-13: upsert overwrites existing flag value', async () => {
    // First call returns enabled=true; after upsert with false, next read returns false
    let tenantRowEnabled = true;
    const { pool } = makeMockPool((sql) => {
      if (isContext(sql) || sql.includes('RESET')) return { rows: [] };
      if (sql.includes('tenant_feature_flags') && sql.includes('SELECT')) {
        return { rows: [{ tenant_id: TENANT, flag_key: 'my-flag', enabled: tenantRowEnabled, updated_by: null, updated_at: new Date().toISOString() }] };
      }
      if (sql.includes('tenant_feature_flags') && sql.includes('INSERT')) {
        tenantRowEnabled = false;
        return { rows: [{ tenant_id: TENANT, flag_key: 'my-flag', enabled: false, updated_by: null, updated_at: new Date().toISOString() }] };
      }
      return { rows: [] };
    });
    const platformRepo = makePlatformRepo(null);
    const repo = new PgTenantFeatureFlagRepository(pool, platformRepo);

    const before = await repo.isEnabledForTenant(TENANT, 'my-flag');
    expect(before).toBe(true);

    await repo.setTenantFlag(TENANT, 'my-flag', false);

    const after = await repo.isEnabledForTenant(TENANT, 'my-flag');
    expect(after).toBe(false);
  });
});
