import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgTenantFeatureFlagRepository } from '../../src/flags/pg-tenant-feature-flags';
import { InMemoryFeatureFlagRepository } from '../../src/flags/feature-flags';

/**
 * U3 integration — pins the DEFAULT-ON supervisor gate against real Postgres.
 * With no platform flag and no tenant override, isEnabledForTenantWithDefault
 * returns the default (true); an explicit tenant override (enabled=false) is the
 * opt-OUT kill switch and wins. This is the behavior the supervisor gate relies
 * on so every tenant gets the trust mechanism without a manual opt-in.
 */
describe('Postgres integration — supervisor default-on gate (U3)', () => {
  let pool: Pool;
  let flags: PgTenantFeatureFlagRepository;
  const FLAG = 'supervisor_agent';

  beforeAll(async () => {
    pool = await getSharedTestDb();
    // Empty platform repo → no platform flag row, so the default branch decides.
    flags = new PgTenantFeatureFlagRepository(pool, new InMemoryFeatureFlagRepository());
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('no override + no platform flag → returns the default (true = default-on)', async () => {
    const tenant = await createTestTenant(pool);
    expect(await flags.isEnabledForTenantWithDefault(tenant.tenantId, FLAG, true)).toBe(true);
    // And the legacy default-false resolver still reports false for the same row.
    expect(await flags.isEnabledForTenant(tenant.tenantId, FLAG)).toBe(false);
  });

  it('explicit tenant override enabled=false is the opt-out kill switch', async () => {
    const tenant = await createTestTenant(pool);
    await flags.setTenantFlag(tenant.tenantId, FLAG, false);
    expect(await flags.isEnabledForTenantWithDefault(tenant.tenantId, FLAG, true)).toBe(false);
  });

  it('explicit tenant override enabled=true keeps it on', async () => {
    const tenant = await createTestTenant(pool);
    await flags.setTenantFlag(tenant.tenantId, FLAG, true);
    expect(await flags.isEnabledForTenantWithDefault(tenant.tenantId, FLAG, true)).toBe(true);
  });
});
