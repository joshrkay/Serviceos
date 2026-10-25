/**
 * loadOnboardingFacts' raw reads run under the tenant's context (raw-pg audit
 * 2026-10-23 §4 P1.11): on the request's client inside a request for that
 * tenant (GET /api/onboarding/status, POST /api/onboarding/test-call/skip),
 * and otherwise — the setup-reminder sweep, which has no request — in ONE
 * tenant session of their own instead of the raw pool. The settings
 * repository read comes first, so off-request no two connections are held at
 * once. Fake tenant pool (test/helpers/fake-tenant-pool.ts); real Postgres in
 * test/integration/onboarding-facts-tenant-context.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { loadOnboardingFacts } from '../../src/onboarding/load-facts';
import { tenantContextStore } from '../../src/middleware/tenant-context';
import type { SettingsRepository } from '../../src/settings/settings';
import { fakeTenantPool } from '../helpers/fake-tenant-pool';

const TENANT = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';

const FACT_TABLES = /tenant_integrations|FROM tenants|voice_sessions|tenant_settings|pack_activations|onboarding_drafts|FROM proposals/;

function respond(draft: 'none' | 'approved') {
  return (sql: string) => {
    if (/FROM onboarding_drafts/.test(sql) && !/FROM proposals/.test(sql)) {
      return draft === 'approved' ? { rows: [{ status: 'approved', version: 2, n: 7, expected: 2 }] } : { rows: [] };
    }
    if (/FROM proposals/.test(sql)) return { rows: [{ status: 'executed', approved_at: new Date('2026-10-01T00:00:00Z') }] };
    if (/FROM tenants/.test(sql)) return { rows: [{ stripe_subscription_id: 'sub_1', subscription_status: 'trialing', created_at: new Date() }] };
    if (/COUNT\(\*\)::int AS n FROM voice_sessions/.test(sql)) return { rows: [{ n: 3 }] };
    return { rows: [] };
  };
}

function settingsRepo(order: string[], fake: ReturnType<typeof fakeTenantPool>) {
  return {
    findByTenant: vi.fn(async () => {
      order.push(`settings (open ${fake.open()})`);
      return null;
    }),
  } as unknown as SettingsRepository;
}

const verb = (sql: string) =>
  /set_config\('app\.current_tenant_id'/.test(sql) ? 'CONTEXT' : FACT_TABLES.test(sql) ? 'READ' : sql.trim().split(/\s+/)[0]!;

describe('loadOnboardingFacts — tenant context for its raw reads', () => {
  it('off-request (the setup-reminder sweep): the six fact reads run in ONE tenant session, after the settings read', async () => {
    const fake = fakeTenantPool(respond('none'));
    const order: string[] = [];

    const facts = await loadOnboardingFacts({ pool: fake.pool, settingsRepo: settingsRepo(order, fake) }, TENANT);

    expect(order).toEqual(['settings (open 0)']);
    expect(fake.statements.map((st) => [st.checkout, verb(st.sql)])).toEqual([
      [0, 'BEGIN'],
      [0, 'CONTEXT'],
      ...Array.from({ length: 6 }, () => [0, 'READ']),
      [0, 'COMMIT'],
    ]);
    expect(fake.statements[1]!.values).toEqual([TENANT]);
    expect(fake.open()).toBe(0);
    expect(facts).toMatchObject({ tenantId: TENANT, inboundCallCount: 3, draft: null, subscription: { status: 'trialing' } });
  });

  it("off-request with an approved draft: the proposals read joins the same session", async () => {
    const fake = fakeTenantPool(respond('approved'));

    const facts = await loadOnboardingFacts({ pool: fake.pool, settingsRepo: settingsRepo([], fake) }, TENANT);

    expect(fake.checkouts()).toBe(1);
    expect(fake.statements.map((st) => verb(st.sql))).toEqual(['BEGIN', 'CONTEXT', ...Array(7).fill('READ'), 'COMMIT']);
    expect(facts.draft).toMatchObject({ status: 'approved', proposals: { expected: 2, members: [{ status: 'executed' }] } });
  });

  it("inside a request for the tenant, every read rides the request's client: no checkout, no session of its own", async () => {
    const fake = fakeTenantPool(respond('approved'));
    const requestRan: string[] = [];
    const requestClient = {
      query: vi.fn(async (sql: string) => {
        requestRan.push(sql);
        return respond('approved')(sql);
      }),
    } as unknown as PoolClient;

    await tenantContextStore.run({ client: requestClient, tenantId: TENANT }, () =>
      loadOnboardingFacts({ pool: fake.pool, settingsRepo: settingsRepo([], fake) }, TENANT),
    );

    expect(fake.checkouts()).toBe(0);
    expect(requestRan.map(verb)).toEqual(Array(7).fill('READ'));
  });

  it("inside a request for ANOTHER tenant, the reads do not borrow that request's client: they take a session for their own tenant", async () => {
    const fake = fakeTenantPool(respond('none'));
    const requestClient = {
      query: vi.fn(async () => {
        throw new Error("ran on another tenant's request client");
      }),
    } as unknown as PoolClient;

    await tenantContextStore.run({ client: requestClient, tenantId: OTHER }, () =>
      loadOnboardingFacts({ pool: fake.pool, settingsRepo: settingsRepo([], fake) }, TENANT),
    );

    expect(requestClient.query).not.toHaveBeenCalled();
    expect(fake.checkouts()).toBe(1);
    expect(fake.statements[1]!.values).toEqual([TENANT]);
  });
});
