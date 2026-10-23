/**
 * Seeded-price baseline (U6, migration 324): the seeder writes positive,
 * per-row provenance on exactly what a setup re-run may later reprice — the
 * pack's two headline catalog items (`seedKey`, `seededUnitPriceCents`) and
 * the template lines seeded from them (`seededUnitPriceCents` +
 * `seededCatalogItemId`, together or not at all). Everything else is the
 * owner's from the start. The real-column half of this lives in
 * test/integration/reprice-seeded.test.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { packHeadlinePrices, seedPackDefaults, SEEDABLE_PACK_IDS } from '../../src/packs/seed-pack-defaults';
import { createCatalogItem, InMemoryCatalogItemRepository } from '../../src/catalog/catalog-item';
import { InMemoryEstimateTemplateRepository } from '../../src/templates/estimate-template';

const TENANT = '00000000-0000-0000-0000-0000000000dd';

describe('seedPackDefaults — seeded-price provenance', () => {
  let catalogRepo: InMemoryCatalogItemRepository;
  let templateRepo: InMemoryEstimateTemplateRepository;

  beforeEach(() => {
    catalogRepo = new InMemoryCatalogItemRepository();
    templateRepo = new InMemoryEstimateTemplateRepository();
  });

  it('(g) every pack, other included, has exactly one catalog seed per headline role', async () => {
    expect(SEEDABLE_PACK_IDS).toContain('other');
    for (const packId of SEEDABLE_PACK_IDS) {
      const repo = new InMemoryCatalogItemRepository();
      await seedPackDefaults(
        { tenantId: TENANT, packId, tradeLabel: packId === 'other' ? 'Pool Service' : undefined },
        { catalogRepo: repo, templateRepo: new InMemoryEstimateTemplateRepository() },
      );
      const catalog = await repo.listByTenant(TENANT);
      const headline = packHeadlinePrices(packId)!;
      const visit = catalog.filter((c) => c.seedKey === `${packId}:visit`);
      const labor = catalog.filter((c) => c.seedKey === `${packId}:labor`);
      expect(visit, `${packId} visit`).toHaveLength(1);
      expect(labor, `${packId} labor`).toHaveLength(1);
      expect(visit[0].unitPriceCents, packId).toBe(headline.visitCents);
      expect(labor[0].unitPriceCents, packId).toBe(headline.laborCents);
      expect(catalog.filter((c) => c.seedKey != null), packId).toHaveLength(2);
    }
  });

  it('stamps the chosen prices as the baseline on the two headline items only', async () => {
    await seedPackDefaults(
      { tenantId: TENANT, packId: 'plumbing', pricing: { tripFeeCents: 8900, hourlyRateCents: 15000 } },
      { catalogRepo, templateRepo },
    );
    const catalog = await catalogRepo.listByTenant(TENANT);
    const stamped = catalog
      .filter((c) => c.seedKey != null || c.seededUnitPriceCents != null)
      .map((c) => [c.name, c.seedKey, c.unitPriceCents, c.seededUnitPriceCents]);
    expect(stamped).toEqual([
      ['Plumbing Diagnostic Fee', 'plumbing:visit', 8900, 8900],
      ['Plumbing Labor', 'plumbing:labor', 15000, 15000],
    ]);
  });

  it('links each template line priced at a headline price to that headline item, and no other line', async () => {
    await seedPackDefaults(
      { tenantId: TENANT, packId: 'hvac', pricing: { tripFeeCents: 9900, hourlyRateCents: 11000 } },
      { catalogRepo, templateRepo },
    );
    const catalog = await catalogRepo.listByTenant(TENANT);
    const visitId = catalog.find((c) => c.name === 'HVAC Diagnostic Fee')!.id;
    const laborId = catalog.find((c) => c.name === 'HVAC Labor')!.id;

    const lines = (await templateRepo.findByTenant(TENANT))
      .flatMap((t) => t.lineItemTemplates.map((l) => ({ template: t.name, ...l })))
      .sort((a, b) => `${a.template}/${a.description}`.localeCompare(`${b.template}/${b.description}`));
    expect(lines.map((l) => [l.template, l.description, l.defaultUnitPriceCents, l.seededUnitPriceCents, l.seededCatalogItemId])).toEqual([
      ['AC / Heating Diagnostic Visit', 'Diagnostic + trip fee', 9900, 9900, visitId],
      ['After-Hours Emergency Service', 'Emergency dispatch fee', expect.any(Number), undefined, undefined],
      ['Seasonal Tune-Up', 'Seasonal tune-up', expect.any(Number), undefined, undefined],
      ['Standard AC Repair', 'AC repair labor', 11000, 11000, laborId],
      ['Standard AC Repair', 'Diagnostic + trip fee', 9900, 9900, visitId],
      ['Thermostat Install', 'Thermostat install labor', 11000, 11000, laborId],
    ]);
    for (const l of lines) {
      expect('seededUnitPriceCents' in l, l.description).toBe('seededCatalogItemId' in l);
    }
  });

  it('a headline seed skipped because the owner already has that name stamps nothing, and its lines stay keyless', async () => {
    await catalogRepo.create(
      createCatalogItem({ tenantId: TENANT, name: 'hvac labor', category: 'Labor', unit: 'hour', unitPriceCents: 13000 }),
    );
    await seedPackDefaults({ tenantId: TENANT, packId: 'hvac' }, { catalogRepo, templateRepo });

    const catalog = await catalogRepo.listByTenant(TENANT);
    expect(catalog.filter((c) => c.seedKey === 'hvac:labor')).toEqual([]);
    expect(catalog.find((c) => c.name === 'hvac labor')).toMatchObject({ unitPriceCents: 13000 });
    expect(catalog.find((c) => c.name === 'hvac labor')?.seedKey ?? null).toBeNull();

    const repair = (await templateRepo.findByTenant(TENANT)).find((t) => t.name === 'Standard AC Repair')!;
    expect(repair.lineItemTemplates[0].seededCatalogItemId).toBe(catalog.find((c) => c.seedKey === 'hvac:visit')!.id);
    expect(repair.lineItemTemplates[1]).not.toHaveProperty('seededCatalogItemId');
    expect(repair.lineItemTemplates[1]).not.toHaveProperty('seededUnitPriceCents');
  });

  it('finds a renamed headline item by its seed key: no duplicate, and new lines link to it', async () => {
    await seedPackDefaults({ tenantId: TENANT, packId: 'hvac' }, { catalogRepo, templateRepo });
    const labor = (await catalogRepo.listByTenant(TENANT)).find((c) => c.seedKey === 'hvac:labor')!;
    await catalogRepo.update(TENANT, labor.id, { name: 'Shop Labor' });
    const repair = (await templateRepo.findByTenant(TENANT)).find((t) => t.name === 'Standard AC Repair')!;
    await templateRepo.update(TENANT, repair.id, { name: 'Old AC Repair' });

    const result = await seedPackDefaults({ tenantId: TENANT, packId: 'hvac' }, { catalogRepo, templateRepo });

    expect(result.catalogItemsCreated).toBe(0);
    const catalog = await catalogRepo.listByTenant(TENANT);
    expect(catalog.filter((c) => c.seedKey === 'hvac:labor').map((c) => c.name)).toEqual(['Shop Labor']);
    const reseeded = (await templateRepo.findByTenant(TENANT)).find((t) => t.name === 'Standard AC Repair')!;
    expect(reseeded.lineItemTemplates[1]).toMatchObject({ seededCatalogItemId: labor.id, seededUnitPriceCents: 12500 });
  });

  it('an archived headline item is not that role any more: a re-activation seeds a live one and links new lines to it', async () => {
    await seedPackDefaults({ tenantId: TENANT, packId: 'hvac' }, { catalogRepo, templateRepo });
    const archived = (await catalogRepo.listByTenant(TENANT)).find((c) => c.seedKey === 'hvac:labor')!;
    await catalogRepo.archive(TENANT, archived.id);
    const repair = (await templateRepo.findByTenant(TENANT)).find((t) => t.name === 'Standard AC Repair')!;
    await templateRepo.update(TENANT, repair.id, { name: 'Old AC Repair' });

    await seedPackDefaults({ tenantId: TENANT, packId: 'hvac' }, { catalogRepo, templateRepo });

    const live = (await catalogRepo.listByTenant(TENANT)).filter((c) => c.seedKey === 'hvac:labor');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ name: 'HVAC Labor', unitPriceCents: 12500, seededUnitPriceCents: 12500 });
    expect(live[0].id).not.toBe(archived.id);
    const reseeded = (await templateRepo.findByTenant(TENANT)).find((t) => t.name === 'Standard AC Repair')!;
    expect(reseeded.lineItemTemplates[1]).toMatchObject({ seededCatalogItemId: live[0].id });
  });
});
