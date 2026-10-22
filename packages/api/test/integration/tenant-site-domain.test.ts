/**
 * D-044 / #1770 — the connected domain, pinned against the real columns
 * (migrations 344/345): claims are per business, only a VERIFIED domain is
 * unique and served, the Host lookup finds only live verified domains across
 * tenants, partial updates leave absent fields alone, and the sweep's due list
 * is cross-tenant and ordered.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgTenantSiteRepository, TenantSiteDomainTakenError } from '../../src/tenant-site/tenant-site';

describe('Postgres integration — tenant site connected domain (D-044 / #1770)', () => {
  let pool: Pool;
  let repo: PgTenantSiteRepository;
  let tenantA: string;
  let tenantB: string;
  const suffix = Math.random().toString(36).slice(2, 8);
  const domain = `www.acme-${suffix}.test`;
  const t0 = new Date('2026-10-22T12:00:00Z');

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgTenantSiteRepository(pool);
    ({ tenantId: tenantA } = await createTestTenant(pool));
    ({ tenantId: tenantB } = await createTestTenant(pool));
    await repo.setSlug(tenantA, `acme-${suffix}`);
    await repo.setSlug(tenantB, `bravo-${suffix}`);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('claims a domain as pending_dns with a clean history; none for a tenant without a site', async () => {
    const claimed = await repo.setCustomDomain(tenantA, domain, t0);
    expect(claimed?.customDomain).toMatchObject({
      domain,
      status: 'pending_dns',
      error: null,
      providerRef: null,
      attempts: 0,
    });
    expect(claimed?.customDomain?.nextCheckAt?.toISOString()).toBe(t0.toISOString());
    const { tenantId: bare } = await createTestTenant(pool);
    expect(await repo.setCustomDomain(bare, domain, t0)).toBeNull();
  });

  it('a partial update changes only the keys given, and can null one', async () => {
    const step = await repo.updateCustomDomain(tenantA, domain, {
      status: 'pending_certificate',
      providerRef: 'ref-1',
      error: 'certificate_failed',
      attempts: 2,
      checkedAt: t0,
      nextCheckAt: new Date(t0.getTime() + 60_000),
    });
    expect(step?.customDomain).toMatchObject({ status: 'pending_certificate', providerRef: 'ref-1', error: 'certificate_failed', attempts: 2 });

    const cleared = await repo.updateCustomDomain(tenantA, domain, { error: null });
    expect(cleared?.customDomain).toMatchObject({ error: null, providerRef: 'ref-1', status: 'pending_certificate', attempts: 2 });
    // A stale domain name never overwrites a swapped claim.
    expect(await repo.updateCustomDomain(tenantA, 'www.other.test', { status: 'failed' })).toBeNull();
  });

  it('the due list is cross-tenant, soonest first, and skips verified and not-yet-due claims', async () => {
    await repo.setCustomDomain(tenantB, `www.bravo-${suffix}.test`, new Date(t0.getTime() - 60_000));
    const due = (await repo.listDueCustomDomains(new Date(t0.getTime() + 120_000), 50)).filter((s) =>
      [tenantA, tenantB].includes(s.tenantId),
    );
    expect(due.map((s) => s.tenantId)).toEqual([tenantB, tenantA]);
    expect(await repo.listDueCustomDomains(new Date(t0.getTime() - 3_600_000), 50)).not.toContainEqual(
      expect.objectContaining({ tenantId: tenantA }),
    );
  });

  it('only a verified, published domain is served; only a verified one is taken', async () => {
    expect(await repo.findPublishedByDomain(domain)).toBeNull();
    expect(await repo.isDomainTaken(domain)).toBe(false);

    await repo.updateCustomDomain(tenantA, domain, { status: 'verified', error: null, nextCheckAt: null, verifiedAt: t0 });
    expect(await repo.findPublishedByDomain(domain)).toBeNull(); // still unpublished
    await repo.setPublished(tenantA, true, t0);
    expect(await repo.findPublishedByDomain(domain)).toMatchObject({ tenantId: tenantA });

    expect(await repo.isDomainTaken(domain)).toBe(true);
    expect(await repo.isDomainTaken(domain, tenantA)).toBe(false);
    expect((await repo.listDueCustomDomains(new Date('2030-01-01T00:00:00Z'), 100)).map((s) => s.tenantId)).not.toContain(tenantA);
  });

  it('a second business can claim the same name but cannot verify it', async () => {
    await repo.setCustomDomain(tenantB, domain, t0);
    expect((await repo.findByTenant(tenantB))?.customDomain?.status).toBe('pending_dns');
    await expect(repo.updateCustomDomain(tenantB, domain, { status: 'verified' })).rejects.toBeInstanceOf(
      TenantSiteDomainTakenError,
    );
  });

  it('restart and clear reset the history', async () => {
    const restarted = await repo.restartCustomDomain(tenantA, t0);
    expect(restarted?.customDomain).toMatchObject({ domain, status: 'pending_dns', providerRef: null, attempts: 0, verifiedAt: null });
    expect(await repo.findPublishedByDomain(domain)).toBeNull();

    const cleared = await repo.clearCustomDomain(tenantA);
    expect(cleared?.customDomain).toBeNull();
    expect(await repo.restartCustomDomain(tenantA, t0)).toBeNull();
  });

  it("one business never reads another's claim", async () => {
    expect((await repo.findByTenant(tenantA))?.customDomain).toBeNull();
    expect((await repo.findByTenant(tenantB))?.customDomain?.domain).toBe(domain);
  });
});
