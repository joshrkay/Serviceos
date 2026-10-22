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
                                  google_review_url, presence_path, call_routing_mode, forwarding_source_number,
                                  forwarding_verified_at, get_found_skipped_items)
     VALUES (gen_random_uuid(), $1, 'Acme', '{}'::jsonb, 'EST', 'INV', 1, 1, 30,
             'https://g.page/r/acme/review', 'google_only', 'forward_unanswered', '+16025550100',
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
      callRoutingMode: 'forward_unanswered',
      rivetNumberProvisioned: true,
      forwardingVerifiedAt: new Date('2026-10-22T15:00:00Z'),
      skippedItems: ['call_routing'],
    });

    expect(await loadGetFoundFacts(pool, neighbour.tenantId)).toEqual({
      presencePath: null,
      googleProfile: 'none',
      googleReviewUrl: null,
      callRoutingMode: null,
      rivetNumberProvisioned: false,
      forwardingVerifiedAt: null,
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
});
