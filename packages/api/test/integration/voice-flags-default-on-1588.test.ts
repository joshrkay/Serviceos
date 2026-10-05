/**
 * #1588 — the voice capability flags resolve DEFAULT-ON against real Postgres.
 *
 * `voice_extended_intents` was read but never seeded, so every tenant was off;
 * `voice_multi_action` is new and gates the memo router's chaining. Both now go
 * through `createVoiceFlagResolver`, the U3 default-on pattern:
 *
 *   tenant_feature_flags override → platform _feature_flags → ON
 *
 * This file pins that order where it is enforced — the RLS-scoped override
 * table and the platform repo — through the production resolver, not through
 * a side-channel read of the rows.
 *
 * Docker-gated. Run against your own database:
 *   EXTERNAL_TEST_DB_URL=postgres://postgres:test@127.0.0.1:55432/<db> \
 *   npx vitest run --config vitest.integration.config.mts \
 *     test/integration/voice-flags-default-on-1588.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgTenantFeatureFlagRepository } from '../../src/flags/pg-tenant-feature-flags';
import { InMemoryFeatureFlagRepository } from '../../src/flags/feature-flags';
import { createVoiceFlagResolver, type VoiceFlagResolver } from '../../src/flags/voice-flags';

describe('Postgres integration — voice flags default-on (#1588)', () => {
  let pool: Pool;
  let platformFlags: InMemoryFeatureFlagRepository;
  let tenantFlags: PgTenantFeatureFlagRepository;
  let voiceFlags: VoiceFlagResolver;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    platformFlags = new InMemoryFeatureFlagRepository();
    tenantFlags = new PgTenantFeatureFlagRepository(pool, platformFlags);
    voiceFlags = createVoiceFlagResolver({ tenantFeatureFlags: tenantFlags, featureFlagRepo: platformFlags });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('a tenant with no override row and no platform flag gets both capabilities ON', async () => {
    const tenant = await createTestTenant(pool);
    expect(await voiceFlags.extendedIntentsEnabled(tenant.tenantId)).toBe(true);
    expect(await voiceFlags.multiActionEnabled(tenant.tenantId)).toBe(true);
  });

  it("an owner's enabled=false override is the opt-out, and only for that tenant", async () => {
    const optedOut = await createTestTenant(pool);
    const neighbour = await createTestTenant(pool);
    await tenantFlags.setTenantFlag(optedOut.tenantId, 'voice_extended_intents', false);

    expect(await voiceFlags.extendedIntentsEnabled(optedOut.tenantId)).toBe(false);
    expect(await voiceFlags.extendedIntentsEnabled(neighbour.tenantId)).toBe(true);
  });

  it("a tenant's own enabled=true override wins over a platform kill switch (#1011 §E3 precedent)", async () => {
    const tenant = await createTestTenant(pool);
    await platformFlags.upsert({ name: 'voice_multi_action', enabled: false });
    await tenantFlags.setTenantFlag(tenant.tenantId, 'voice_multi_action', true);

    expect(await voiceFlags.multiActionEnabled(tenant.tenantId)).toBe(true);
    await platformFlags.delete('voice_multi_action');
  });
});
