/**
 * resolvePublicBusinessPhone's tenant_integrations fallback runs under the RLS
 * runtime role (raw-pg audit 2026-10-23 §4 P2.6): on the caller's tenant
 * transaction when it holds one for this tenant, otherwise in one tenant
 * session of its own — never as a bare pool.query on the principal.
 * The real-Postgres proof is test/integration/public-intake-tenant-context.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { resolvePublicBusinessPhone } from '../../src/public-intake/public-business-info';
import { tenantContextStore } from '../../src/middleware/tenant-context';
import { fakeTenantPool } from '../helpers/fake-tenant-pool';

const TENANT = '7d1f0c2a-5b8e-4c3d-9a6f-1e2b3c4d5e6f';
const OTHER = '0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e';
const FALLBACK = /FROM tenant_integrations/;

function integrationPool(row: { phone: string | null; stub?: string | null } | null) {
  return fakeTenantPool((sql) =>
    FALLBACK.test(sql) ? { rows: row ? [{ phone: row.phone, stub: row.stub ?? null }] : [] } : undefined,
  );
}

describe('resolvePublicBusinessPhone — the tenant_integrations fallback', () => {
  it('off any tenant transaction: one tenant session (BEGIN, the GUC + role, the read, COMMIT) on one checkout', async () => {
    const fake = integrationPool({ phone: '+15125550123' });

    expect(await resolvePublicBusinessPhone(null, TENANT, fake.pool)).toBe('+15125550123');

    expect(fake.checkouts()).toBe(1);
    expect(fake.open()).toBe(0);
    const sql = fake.statements.map((s) => s.sql);
    expect(sql[0]).toBe('BEGIN');
    expect(sql[1]).toMatch(/set_config\('app\.current_tenant_id'/);
    expect(fake.statements[1].values).toEqual([TENANT]);
    expect(sql[2]).toMatch(FALLBACK);
    expect(fake.statements[2].values).toEqual([TENANT]);
    expect(sql[3]).toBe('COMMIT');
  });

  it("inside the caller's tenant transaction for this tenant: the read rides its client, no checkout", async () => {
    const own = fakeTenantPool();
    const held = integrationPool({ phone: '+15125550124' });
    const heldClient = await held.pool.connect();

    const phone = await tenantContextStore.run({ client: heldClient, tenantId: TENANT }, () =>
      resolvePublicBusinessPhone({ businessPhone: '  ' }, TENANT, own.pool),
    );

    expect(phone).toBe('+15125550124');
    expect(own.checkouts()).toBe(0);
    expect(held.statements.map((s) => s.sql)).toEqual([expect.stringMatching(FALLBACK)]);
  });

  it("never rides a transaction held for another tenant", async () => {
    const own = integrationPool(null);
    const held = fakeTenantPool();
    const heldClient = await held.pool.connect();

    await tenantContextStore.run({ client: heldClient, tenantId: OTHER }, () =>
      resolvePublicBusinessPhone(null, TENANT, own.pool),
    );

    expect(held.statements).toEqual([]);
    expect(own.checkouts()).toBe(1);
    expect(own.statements[1].values).toEqual([TENANT]);
  });

  it('a dialable settings phone, or no pool, reads nothing', async () => {
    const fake = integrationPool({ phone: '+15125550125' });

    expect(await resolvePublicBusinessPhone({ businessPhone: ' +15125550199 ' }, TENANT, fake.pool)).toBe('+15125550199');
    expect(await resolvePublicBusinessPhone(null, TENANT, undefined)).toBeNull();

    expect(fake.checkouts()).toBe(0);
  });

  it('#880 — a magic test number or a stub row in the fallback, or a magic settings phone, is never served', async () => {
    expect(await resolvePublicBusinessPhone(null, TENANT, integrationPool({ phone: '+15005550006' }).pool)).toBeNull();
    expect(await resolvePublicBusinessPhone(null, TENANT, integrationPool({ phone: '+15125550123', stub: 'true' }).pool)).toBeNull();
    expect(await resolvePublicBusinessPhone(null, TENANT, integrationPool(null).pool)).toBeNull();
    expect(
      await resolvePublicBusinessPhone({ businessPhone: '+15005550006' }, TENANT, integrationPool({ phone: '+15125550126' }).pool),
    ).toBe('+15125550126');
  });
});
