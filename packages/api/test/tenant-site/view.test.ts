/**
 * loadTenantSiteView reads the tenant's settings row and the public phone
 * fallback in ONE tenant transaction under the RLS runtime role (raw-pg audit
 * 2026-10-23 §4 P2.6): its own session on the public host page, the request
 * transaction on /api/tenant-site/preview and /publish. The service list (a
 * global pack-catalog read on a checkout of its own) comes after that
 * transaction, never beside it. Real Postgres:
 * test/integration/public-intake-tenant-context.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { loadTenantSiteView } from '../../src/tenant-site/view';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { tenantContextStore } from '../../src/middleware/tenant-context';
import type { VerticalPackRegistry } from '../../src/shared/vertical-pack-registry';
import { fakeTenantPool, type FakeTenantPool } from '../helpers/fake-tenant-pool';

const TENANT = '2f6c1d9e-8a7b-4c5d-9e0f-1a2b3c4d5e6f';
const SETTINGS = /SELECT \* FROM tenant_settings/;
const FALLBACK = /FROM tenant_integrations/;

function settingsRow(businessName: string) {
  return {
    id: 'settings-1',
    tenant_id: TENANT,
    business_name: businessName,
    business_phone: null,
    timezone: 'America/Chicago',
    business_hours: { mon: { open: '09:00', close: '17:00' } },
    terminology_preferences: { _activeVerticalPacks: ['hvac-pack'] },
    created_at: new Date('2026-10-01T00:00:00Z'),
    updated_at: new Date('2026-10-01T00:00:00Z'),
  };
}

function sitePool(businessName = 'Cool Air Co') {
  return fakeTenantPool((sql) => {
    if (SETTINGS.test(sql)) return { rows: [settingsRow(businessName)] };
    if (FALLBACK.test(sql)) return { rows: [{ phone: '+15125550188', stub: null }] };
    return undefined;
  });
}

/** A pack catalog that notes, in the pool's own statement log, when it is read. */
function packs(fake: FakeTenantPool): VerticalPackRegistry {
  return {
    getByPackId: async (packId: string) => {
      fake.statements.push({ checkout: -1, sql: `<pack catalog: ${packId}, ${fake.open()} open>` });
      return {
        id: 'pack-1',
        packId,
        verticalType: 'hvac',
        displayName: 'Heating & Cooling',
        status: 'active',
        version: '1.0.0',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
    findByVertical: async () => [],
  } as unknown as VerticalPackRegistry;
}

function deps(fake: FakeTenantPool, pool = fake.pool) {
  return {
    settingsRepo: new PgSettingsRepository(pool),
    packRegistry: packs(fake),
    pool,
    webOrigin: 'https://app.example.com',
  };
}

describe('loadTenantSiteView — settings and the phone fallback in one tenant transaction', () => {
  it('off any request (the public host page): one checkout, one BEGIN / context / COMMIT, the catalog read after it', async () => {
    const fake = sitePool();

    const view = await loadTenantSiteView(deps(fake), TENANT);

    expect(view).toMatchObject({ businessName: 'Cool Air Co', phone: '+15125550188', services: ['Heating & Cooling'] });
    expect(fake.checkouts()).toBe(1);
    expect(fake.open()).toBe(0);
    expect(fake.statements.map((s) => s.sql)).toEqual([
      'BEGIN',
      expect.stringMatching(/^SELECT set_config\('app\.current_tenant_id'/),
      expect.stringMatching(SETTINGS),
      expect.stringMatching(FALLBACK),
      'COMMIT',
      '<pack catalog: hvac-pack, 0 open>',
    ]);
    expect(fake.statements[1].values).toEqual([TENANT]);
  });

  it('inside a request for the tenant (preview / publish): both reads ride the request client, no checkout', async () => {
    const own = fakeTenantPool();
    const request = sitePool();
    const requestClient = await request.pool.connect();

    const view = await tenantContextStore.run({ client: requestClient, tenantId: TENANT }, () =>
      loadTenantSiteView(deps(request, own.pool), TENANT),
    );

    expect(view).toMatchObject({ phone: '+15125550188' });
    expect(own.checkouts()).toBe(0);
    expect(request.statements.map((s) => s.sql)).toEqual([
      expect.stringMatching(SETTINGS),
      expect.stringMatching(FALLBACK),
      '<pack catalog: hvac-pack, 1 open>',
    ]);
  });

  it('no business name: null, and neither the phone nor the catalog is read', async () => {
    const fake = sitePool('   ');

    expect(await loadTenantSiteView(deps(fake), TENANT)).toBeNull();

    expect(fake.statements.map((s) => s.sql)).toEqual([
      'BEGIN',
      expect.stringMatching(/^SELECT set_config/),
      expect.stringMatching(SETTINGS),
      'COMMIT',
    ]);
  });
});
