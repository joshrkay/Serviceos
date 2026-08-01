/**
 * Postgres integration — per-tenant Vapi webhook secret resolver.
 *
 * The /webhooks/vapi/:tenantId handler resolves THIS tenant's own secret to
 * verify a call event. Because each tenant has a distinct secret, a body signed
 * for tenant A fails verification at tenant B — closing the cross-tenant forgery
 * that a single global secret allowed. This pins the resolver against the real
 * migrated column, under the tenant's own RLS context, and proves it never
 * returns another tenant's secret.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createVapiSecretResolver } from '../../src/webhooks/integration-resolver';

describe('Postgres integration — createVapiSecretResolver', () => {
  let pool: Pool;
  let resolve: (tenantId: string) => Promise<string | null>;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    resolve = createVapiSecretResolver(pool);
    tenantA = (await createTestTenant(pool)).tenantId;
    tenantB = (await createTestTenant(pool)).tenantId;
    // Superuser test pool bypasses RLS for the seed; distinct secrets per tenant.
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, vapi_webhook_secret)
         VALUES (gen_random_uuid(), $1, 'A Co', $2)`,
      [tenantA, 'secret-for-tenant-A'],
    );
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, vapi_webhook_secret)
         VALUES (gen_random_uuid(), $1, 'B Co', $2)`,
      [tenantB, 'secret-for-tenant-B'],
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('returns each tenant its OWN secret and never the other tenant’s', async () => {
    expect(await resolve(tenantA)).toBe('secret-for-tenant-A');
    expect(await resolve(tenantB)).toBe('secret-for-tenant-B');
    // The crux: tenant A's secret is not what B resolves — so a body Vapi signed
    // with A's secret, POSTed to /webhooks/vapi/<B>, verifies against B's secret
    // and is rejected. Cross-tenant forgery closed.
    expect(await resolve(tenantA)).not.toBe(await resolve(tenantB));
  });

  it('returns null for a tenant with no provisioned secret (→ handler fails CLOSED)', async () => {
    // WS4: null no longer means "fall back to the global secret" — the /vapi
    // handler treats a null secret as an empty secret, which verifyVapiSignature
    // rejects (403). A not-yet-provisioned tenant is fail-closed, not
    // fail-open. See the handler-level assertion in
    // test/integrations/vapi/webhook.test.ts ("fails closed when no per-tenant
    // secret is provisioned").
    const fresh = (await createTestTenant(pool)).tenantId;
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name) VALUES (gen_random_uuid(), $1, 'Fresh Co')`,
      [fresh],
    );
    expect(await resolve(fresh)).toBeNull();
  });

  it('returns null for an unknown / no-row tenant and a malformed id', async () => {
    expect(await resolve('11111111-1111-1111-1111-111111111111')).toBeNull();
    expect(await resolve('not-a-uuid')).toBeNull();
  });
});
