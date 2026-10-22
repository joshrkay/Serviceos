/**
 * D-044 / #1768 — the tenant site, pinned against the real tables
 * (migration 334): one address per business, unique across businesses, the
 * Host lookup finds only LIVE sites across tenants, RLS keeps each business's
 * own record its own, and tenant_settings.website_url round-trips.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgTenantSiteRepository, TenantSiteSlugTakenError } from '../../src/tenant-site/tenant-site';
import { PgSettingsRepository } from '../../src/settings/pg-settings';

describe('Postgres integration — tenant sites (D-044 / #1768)', () => {
  let pool: Pool;
  let repo: PgTenantSiteRepository;
  let tenantA: string;
  let tenantB: string;
  const suffix = Math.random().toString(36).slice(2, 8);
  const slugA = `acme-${suffix}`;
  const slugB = `bravo-${suffix}`;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgTenantSiteRepository(pool);
    ({ tenantId: tenantA } = await createTestTenant(pool));
    ({ tenantId: tenantB } = await createTestTenant(pool));
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('creates an unpublished site, replaces the address, and publishes and unpublishes', async () => {
    const created = await repo.setSlug(tenantA, slugA);
    expect(created).toMatchObject({ tenantId: tenantA, slug: slugA, published: false, publishedAt: null });

    const renamed = await repo.setSlug(tenantA, `${slugA}-2`);
    expect(renamed.slug).toBe(`${slugA}-2`);
    await repo.setSlug(tenantA, slugA);

    const at = new Date('2026-10-22T12:00:00Z');
    const live = await repo.setPublished(tenantA, true, at);
    expect(live).toMatchObject({ published: true });
    expect(live?.publishedAt?.toISOString()).toBe(at.toISOString());

    const down = await repo.setPublished(tenantA, false, new Date());
    expect(down).toMatchObject({ published: false });
    expect(await repo.setPublished(tenantB, true, at)).toBeNull();
  });

  it('the Host lookup finds only live sites, across tenants', async () => {
    expect(await repo.findPublishedBySlug(slugA)).toBeNull();
    await repo.setPublished(tenantA, true, new Date());
    expect(await repo.findPublishedBySlug(slugA)).toMatchObject({ tenantId: tenantA, published: true });
    expect(await repo.findPublishedBySlug(`nobody-${suffix}`)).toBeNull();
    await repo.setPublished(tenantA, false, new Date());
  });

  it('an address belongs to one business', async () => {
    expect(await repo.isSlugTaken(slugA)).toBe(true);
    expect(await repo.isSlugTaken(slugA, tenantA)).toBe(false);
    expect(await repo.isSlugTaken(slugB)).toBe(false);
    await expect(repo.setSlug(tenantB, slugA)).rejects.toBeInstanceOf(TenantSiteSlugTakenError);
    expect(await repo.findByTenant(tenantB)).toBeNull();
  });

  it("one business never reads another's record", async () => {
    await repo.setSlug(tenantB, slugB);
    expect(await repo.findByTenant(tenantA)).toMatchObject({ slug: slugA });
    expect(await repo.findByTenant(tenantB)).toMatchObject({ slug: slugB });
  });

  it('the table refuses a malformed or reserved-shape address', async () => {
    await expect(repo.setSlug(tenantB, 'Has-Caps')).rejects.toThrow(/check constraint/);
    await expect(repo.setSlug(tenantB, 'a')).rejects.toThrow(/check constraint/);
    await expect(repo.setSlug(tenantB, '-lead-hyphen')).rejects.toThrow(/check constraint/);
  });

  it('tenant_settings.website_url round-trips through the settings repository, and clears', async () => {
    const settingsRepo = new PgSettingsRepository(pool);
    await settingsRepo.upsertIdentityFields(tenantA, { businessName: 'Acme' });
    await settingsRepo.upsertIdentityFields(tenantB, { businessName: 'Bravo' });
    await settingsRepo.update(tenantA, { websiteUrl: 'https://joesplumbing.com' });
    expect((await settingsRepo.findByTenant(tenantA))?.websiteUrl).toBe('https://joesplumbing.com');
    expect((await settingsRepo.findByTenant(tenantB))?.websiteUrl).toBeUndefined();
    await settingsRepo.update(tenantA, { websiteUrl: null });
    expect((await settingsRepo.findByTenant(tenantA))?.websiteUrl).toBeUndefined();
  });
});
