/**
 * Docker-gated proof that the Get-found facts loader reads REAL columns
 * (#1750 slice 1). The checklist derivation is pure and unit-tested; this pins
 * the SQL underneath it — the entity resolver once shipped with nonexistent
 * column names because its Pool was mocked (CLAUDE.md).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { loadGetFoundFacts } from '../../src/get-found/load-facts';

/** Twilio numbers are unique across tenants, and every integration file shares one DB. */
const uniqueE164 = () => `+1602${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

async function seedEverything(pool: Pool, tenantId: string): Promise<void> {
  await pool.query(
    `INSERT INTO tenant_settings (id, tenant_id, business_name, terminology_preferences, estimate_prefix, invoice_prefix,
                                  next_estimate_number, next_invoice_number, default_payment_term_days,
                                  google_review_url, presence_path, forwarding_mode, forwarding_source_number,
                                  forwarding_verified_at, get_found_skipped_items)
     VALUES (gen_random_uuid(), $1, 'Acme', '{}'::jsonb, 'EST', 'INV', 1, 1, 30,
             'https://g.page/r/acme/review', 'google_only', 'all_calls', '+16025550100',
             '2026-10-22T15:00:00Z', ARRAY['call_routing'])`,
    [tenantId],
  );
  await pool.query(
    `INSERT INTO tenant_integrations (id, tenant_id, provider, status, credentials)
     VALUES (gen_random_uuid(), $1, 'google_business', 'full_readiness', $2::jsonb)`,
    [tenantId, JSON.stringify({ providerData: { accountId: 'accounts/1', locationId: 'locations/2' } })],
  );
  await pool.query(
    `INSERT INTO tenant_integrations (id, tenant_id, provider, status, provider_data)
     VALUES (gen_random_uuid(), $1, 'twilio', 'full_readiness', $2::jsonb)`,
    [tenantId, JSON.stringify({ phoneE164: uniqueE164() })],
  );
  // The first real (customer) call, as voice/activation.ts stamps it.
  await pool.query(`UPDATE tenant_settings SET activated_at = now() WHERE tenant_id = $1`, [tenantId]);
}

describe('loadGetFoundFacts (integration)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });
  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('reads every Get-found fact for a fully set-up tenant, and nothing from its neighbour', async () => {
    const tenant = await createTestTenant(pool);
    const neighbour = await createTestTenant(pool);
    await seedEverything(pool, tenant.tenantId);

    expect(await loadGetFoundFacts(pool, tenant.tenantId)).toEqual({
      presencePath: 'google_only',
      googleProfile: 'verified',
      googleReviewUrl: 'https://g.page/r/acme/review',
      hasExistingLine: true,
      forwardingCheckPassedAt: new Date('2026-10-22T15:00:00Z'),
      rivetNumberLive: true,
      firstRealCallReceived: true,
      skippedItems: ['call_routing'],
    });

    expect(await loadGetFoundFacts(pool, neighbour.tenantId)).toEqual({
      presencePath: null,
      googleProfile: 'none',
      googleReviewUrl: null,
      hasExistingLine: false,
      forwardingCheckPassedAt: null,
      rivetNumberLive: false,
      firstRealCallReceived: false,
      skippedItems: [],
    });
  });

  it('does not count a Google connection that never found a location as a profile', async () => {
    const tenant = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO tenant_integrations (id, tenant_id, provider, status, credentials)
       VALUES (gen_random_uuid(), $1, 'google_business', 'full_readiness', $2::jsonb)`,
      [tenant.tenantId, JSON.stringify({ providerData: {} })],
    );

    expect((await loadGetFoundFacts(pool, tenant.tenantId)).googleProfile).toBe('none');
  });

  it('does not count the onboarding test call as a real call', async () => {
    const tenant = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO voice_sessions (id, tenant_id, channel, state, started_at, ended_at)
       VALUES (gen_random_uuid(), $1, 'voice_inbound', 'ended', now() - interval '1 minute', now())`,
      [tenant.tenantId],
    );

    expect((await loadGetFoundFacts(pool, tenant.tenantId)).firstRealCallReceived).toBe(false);
  });

  it("counts an existing business line from onboarding's answer before any forwarding is set up", async () => {
    const tenant = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO onboarding_drafts (tenant_id, pack_id, trade, business_name, assembled, choices)
       VALUES ($1, 'plumbing', 'plumbing', 'Acme', '{}'::jsonb, $2::jsonb)`,
      [tenant.tenantId, JSON.stringify({ existing_number: { option: 'b' } })],
    );

    expect((await loadGetFoundFacts(pool, tenant.tenantId)).hasExistingLine).toBe(true);
  });
});
