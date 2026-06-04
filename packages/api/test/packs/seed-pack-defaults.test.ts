/**
 * Tests for the pack-default seeder that backs `POST /api/onboarding/pack`.
 *
 * The onboarding wizard promises "we'll set up job types, pricing, and
 * message templates for you" when an operator picks a trade. Before this
 * helper landed, only the `pack_activations` row was written and the
 * tenant landed on an empty estimate / job-type screen. These tests
 * guard the contract:
 *   - HVAC seeds the canonical catalog_items + estimate_templates.
 *   - Plumbing does the same with its own defaults.
 *   - Re-seeding is a no-op (idempotency — the wizard route calls this
 *     on every activation, including reactivations).
 *   - An unknown packId is a quiet no-op so the route can't 500 the
 *     wizard if the registry drifts ahead of the seeder.
 *   - Estimate templates carry the default customer message — that's
 *     where the "message templates" promise is fulfilled today
 *     (see TODO in seed-pack-defaults.ts re: dedicated table).
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  seedPackDefaults,
  isSeedablePackId,
} from '../../src/packs/seed-pack-defaults';
import { InMemoryCatalogItemRepository } from '../../src/catalog/catalog-item';
import { InMemoryEstimateTemplateRepository } from '../../src/templates/estimate-template';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000bb';

describe('seedPackDefaults', () => {
  let catalogRepo: InMemoryCatalogItemRepository;
  let templateRepo: InMemoryEstimateTemplateRepository;

  beforeEach(() => {
    catalogRepo = new InMemoryCatalogItemRepository();
    templateRepo = new InMemoryEstimateTemplateRepository();
  });

  it('seeds HVAC catalog items and job-type templates on a clean tenant', async () => {
    const result = await seedPackDefaults(
      { tenantId: TENANT, packId: 'hvac', actorId: 'owner-1' },
      { catalogRepo, templateRepo },
    );

    expect(result.alreadySeeded).toBe(false);
    expect(result.catalogItemsCreated).toBeGreaterThan(0);
    expect(result.templatesCreated).toBeGreaterThan(0);

    const catalog = await catalogRepo.listByTenant(TENANT);
    const templates = await templateRepo.findByTenant(TENANT);

    expect(catalog.length).toBe(result.catalogItemsCreated);
    expect(templates.length).toBe(result.templatesCreated);

    // The wizard's "pricing" promise — we should have at least an hourly
    // labor entry and a diagnostic fee in the price book.
    const labor = catalog.find((c) => c.name === 'HVAC Labor');
    expect(labor).toBeDefined();
    expect(labor?.unit).toBe('hour');
    expect(labor?.unitPriceCents).toBeGreaterThan(0);

    // Pack-prefixed name — see seed-pack-defaults.ts hvacCatalogSeeds
    // comment for why HVAC and plumbing seeds carry distinct names.
    const diagnostic = catalog.find((c) => c.name === 'HVAC Diagnostic Fee');
    expect(diagnostic).toBeDefined();

    // The "job types" promise — every template is HVAC and carries a
    // categoryId so the estimate builder can group them.
    for (const t of templates) {
      expect(t.verticalType).toBe('hvac');
      expect(t.categoryId).toBeTruthy();
      expect(t.lineItemTemplates.length).toBeGreaterThan(0);
    }
    expect(templates.some((t) => t.name === 'Standard AC Repair')).toBe(true);

    // The "message templates" promise — bundled into each template's
    // defaultCustomerMessage until we cut a dedicated table post-launch.
    for (const t of templates) {
      expect(t.defaultCustomerMessage).toBeTruthy();
      expect((t.defaultCustomerMessage ?? '').length).toBeGreaterThan(10);
    }
  });

  it('seeds Plumbing with its own canonical defaults', async () => {
    const result = await seedPackDefaults(
      { tenantId: TENANT, packId: 'plumbing' },
      { catalogRepo, templateRepo },
    );

    expect(result.alreadySeeded).toBe(false);
    expect(result.catalogItemsCreated).toBeGreaterThan(0);
    expect(result.templatesCreated).toBeGreaterThan(0);

    const templates = await templateRepo.findByTenant(TENANT);
    for (const t of templates) {
      expect(t.verticalType).toBe('plumbing');
    }
    expect(templates.some((t) => t.name === 'Leak Repair')).toBe(true);
    expect(templates.some((t) => t.name === 'Drain Cleaning')).toBe(true);
  });

  it('seeds the missing rows even when one template name pre-exists (per-seed idempotency)', async () => {
    // Regression: an earlier version of the seeder probed for ANY of
    // the seed names in existing templates and bailed the whole pack
    // when even one matched. A tenant with a manually-created template
    // named "Seasonal Tune-Up" (a common entry) was then stuck with
    // zero catalog items and zero remaining templates after activating
    // HVAC. The fix is per-seed name checks so the pre-existing row is
    // skipped but everything else still seeds.
    const seedDate = new Date();
    await templateRepo.create({
      id: '11111111-1111-1111-1111-111111111111',
      tenantId: TENANT,
      verticalType: 'hvac',
      categoryId: 'manual-cat',
      name: 'Seasonal Tune-Up',
      description: 'I made this myself',
      lineItemTemplates: [],
      defaultDiscountCents: 0,
      defaultTaxRateBps: 0,
      isActive: true,
      usageCount: 0,
      createdBy: undefined,
      createdAt: seedDate,
      updatedAt: seedDate,
    });

    const result = await seedPackDefaults(
      { tenantId: TENANT, packId: 'hvac' },
      { catalogRepo, templateRepo },
    );

    expect(result.alreadySeeded).toBe(false);
    expect(result.templatesCreated).toBeGreaterThan(0);
    expect(result.catalogItemsCreated).toBeGreaterThan(0);

    const templatesAfter = await templateRepo.findByTenant(TENANT);
    // The manual template stays at its original description; the seed
    // didn't overwrite it.
    const manual = templatesAfter.find((t) => t.name === 'Seasonal Tune-Up');
    expect(manual?.description).toBe('I made this myself');
  });

  it('is idempotent — re-seeding the same pack is a no-op', async () => {
    const first = await seedPackDefaults(
      { tenantId: TENANT, packId: 'hvac' },
      { catalogRepo, templateRepo },
    );
    const second = await seedPackDefaults(
      { tenantId: TENANT, packId: 'hvac' },
      { catalogRepo, templateRepo },
    );

    expect(first.alreadySeeded).toBe(false);
    expect(second.alreadySeeded).toBe(true);
    expect(second.catalogItemsCreated).toBe(0);
    expect(second.templatesCreated).toBe(0);

    const catalogAfter = await catalogRepo.listByTenant(TENANT);
    const templatesAfter = await templateRepo.findByTenant(TENANT);
    expect(catalogAfter.length).toBe(first.catalogItemsCreated);
    expect(templatesAfter.length).toBe(first.templatesCreated);
  });

  it('scopes seeded rows to the tenant — other tenants stay empty', async () => {
    await seedPackDefaults(
      { tenantId: TENANT, packId: 'hvac' },
      { catalogRepo, templateRepo },
    );

    const otherCatalog = await catalogRepo.listByTenant(OTHER_TENANT);
    const otherTemplates = await templateRepo.findByTenant(OTHER_TENANT);

    expect(otherCatalog).toEqual([]);
    expect(otherTemplates).toEqual([]);
  });

  it('a tenant on both packs gets both Diagnostic Fees at their pack prices', async () => {
    // Regression for the catalog name-collision: before the seed names
    // were pack-prefixed, plumbing's "Diagnostic Fee" was deduped against
    // HVAC's by name, so the second pack silently kept the first pack's
    // price.
    await seedPackDefaults(
      { tenantId: TENANT, packId: 'hvac' },
      { catalogRepo, templateRepo },
    );
    await seedPackDefaults(
      { tenantId: TENANT, packId: 'plumbing' },
      { catalogRepo, templateRepo },
    );

    const catalog = await catalogRepo.listByTenant(TENANT);
    const hvacDx = catalog.find((c) => c.name === 'HVAC Diagnostic Fee');
    const plumbingDx = catalog.find((c) => c.name === 'Plumbing Diagnostic Fee');
    expect(hvacDx).toBeDefined();
    expect(plumbingDx).toBeDefined();
    // Different sources (HVAC vs plumbing defaults) → different cents.
    expect(hvacDx!.unitPriceCents).not.toBe(plumbingDx!.unitPriceCents);
  });

  it('quietly no-ops on an unknown packId so the route never 500s', async () => {
    const result = await seedPackDefaults(
      { tenantId: TENANT, packId: 'unknown-pack' },
      { catalogRepo, templateRepo },
    );

    expect(result.catalogItemsCreated).toBe(0);
    expect(result.templatesCreated).toBe(0);
    expect(result.alreadySeeded).toBe(false);

    const catalog = await catalogRepo.listByTenant(TENANT);
    expect(catalog).toEqual([]);
  });

  it('isSeedablePackId reports the supported set', () => {
    expect(isSeedablePackId('hvac')).toBe(true);
    expect(isSeedablePackId('plumbing')).toBe(true);
    expect(isSeedablePackId('electrical')).toBe(false);
    expect(isSeedablePackId('garbage')).toBe(false);
  });
});
