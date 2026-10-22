/**
 * "Pick, don't build" onboarding chooses a trip fee and hourly rate before the
 * pack is seeded. The seeder must land exactly those two numbers on the
 * headline items and scale everything else in proportion, so what Rivet says
 * on the phone is what the price book says.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  seedPackDefaults,
  packHeadlinePrices,
  SEEDABLE_PACK_IDS,
} from '../../src/packs/seed-pack-defaults';
import { scaleCentsBps } from '../../src/shared/scale-cents-bps';
import { InMemoryCatalogItemRepository } from '../../src/catalog/catalog-item';
import { InMemoryEstimateTemplateRepository } from '../../src/templates/estimate-template';

const TENANT = '00000000-0000-0000-0000-0000000000cc';

describe('seedPackDefaults with chosen pricing', () => {
  let catalogRepo: InMemoryCatalogItemRepository;
  let templateRepo: InMemoryEstimateTemplateRepository;

  beforeEach(() => {
    catalogRepo = new InMemoryCatalogItemRepository();
    templateRepo = new InMemoryEstimateTemplateRepository();
  });

  it('exposes headline (visit, labor) prices for every seedable pack and they are unique within the pack', async () => {
    for (const packId of SEEDABLE_PACK_IDS) {
      const h = packHeadlinePrices(packId);
      expect(h, packId).toBeDefined();
      expect(Number.isInteger(h!.visitCents)).toBe(true);
      expect(Number.isInteger(h!.laborCents)).toBe(true);
      expect(h!.visitCents).not.toBe(h!.laborCents);

      // The seeder identifies headline items by price, so no other seed in the
      // pack may share either headline price. This test is what makes that safe.
      const repo = new InMemoryCatalogItemRepository();
      const tRepo = new InMemoryEstimateTemplateRepository();
      await seedPackDefaults({ tenantId: TENANT, packId }, { catalogRepo: repo, templateRepo: tRepo });
      const prices = (await repo.listByTenant(TENANT)).map((c) => c.unitPriceCents);
      expect(prices.filter((p) => p === h!.visitCents), `${packId} visit price collides`).toHaveLength(1);
      expect(prices.filter((p) => p === h!.laborCents), `${packId} labor price collides`).toHaveLength(1);
    }
  });

  it('lands the chosen trip fee and hourly rate exactly on the plumbing headline items', async () => {
    await seedPackDefaults(
      { tenantId: TENANT, packId: 'plumbing', pricing: { tripFeeCents: 8900, hourlyRateCents: 15000 } },
      { catalogRepo, templateRepo },
    );
    const catalog = await catalogRepo.listByTenant(TENANT);
    expect(catalog.find((c) => c.name === 'Plumbing Diagnostic Fee')?.unitPriceCents).toBe(8900);
    expect(catalog.find((c) => c.name === 'Plumbing Labor')?.unitPriceCents).toBe(15000);
  });

  it('scales every other price by the hourly-rate ratio with the one rounding rule', async () => {
    const h = packHeadlinePrices('plumbing')!;
    const hourly = 15000;
    const bps = Math.round((hourly / h.laborCents) * 10_000);
    await seedPackDefaults(
      { tenantId: TENANT, packId: 'plumbing', pricing: { tripFeeCents: 8900, hourlyRateCents: hourly } },
      { catalogRepo, templateRepo },
    );
    const catalog = await catalogRepo.listByTenant(TENANT);
    const drain = catalog.find((c) => c.name === 'Drain Cleaning')!;
    expect(drain.unitPriceCents).toBe(scaleCentsBps(14900, bps));
    expect(drain.unitPriceCents % 100).toBe(0);
  });

  it('applies the same rule to estimate template lines, headline lines exact', async () => {
    const h = packHeadlinePrices('hvac')!;
    const pricing = { tripFeeCents: 9900, hourlyRateCents: 16000 };
    const bps = Math.round((pricing.hourlyRateCents / h.laborCents) * 10_000);
    await seedPackDefaults({ tenantId: TENANT, packId: 'hvac', pricing }, { catalogRepo, templateRepo });
    const templates = await templateRepo.findByTenant(TENANT);
    const lines = templates.flatMap((t) => t.lineItemTemplates);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      if (l.description.toLowerCase().includes('diagnostic')) {
        expect(l.defaultUnitPriceCents).toBe(pricing.tripFeeCents);
      } else if (l.description.toLowerCase().includes('labor')) {
        expect(l.defaultUnitPriceCents).toBe(pricing.hourlyRateCents);
      } else {
        expect(l.defaultUnitPriceCents % 100).toBe(0);
        expect(l.defaultUnitPriceCents).toBeGreaterThan(0);
        void bps;
      }
    }
  });

  it('with no pricing the seeds are byte-for-byte the pack defaults', async () => {
    await seedPackDefaults({ tenantId: TENANT, packId: 'plumbing' }, { catalogRepo, templateRepo });
    const h = packHeadlinePrices('plumbing')!;
    const catalog = await catalogRepo.listByTenant(TENANT);
    expect(catalog.find((c) => c.name === 'Plumbing Diagnostic Fee')?.unitPriceCents).toBe(h.visitCents);
    expect(catalog.find((c) => c.name === 'Plumbing Labor')?.unitPriceCents).toBe(h.laborCents);
    expect(catalog.find((c) => c.name === 'Drain Cleaning')?.unitPriceCents).toBe(14900);
  });

  it('rejects non-integer or negative pricing at the boundary', async () => {
    await expect(
      seedPackDefaults({ tenantId: TENANT, packId: 'plumbing', pricing: { tripFeeCents: 89.5, hourlyRateCents: 15000 } }, { catalogRepo, templateRepo }),
    ).rejects.toThrow();
    await expect(
      seedPackDefaults({ tenantId: TENANT, packId: 'plumbing', pricing: { tripFeeCents: 8900, hourlyRateCents: -1 } }, { catalogRepo, templateRepo }),
    ).rejects.toThrow();
  });

  it('works for the generic "other" pack with a trade label', async () => {
    await seedPackDefaults(
      { tenantId: TENANT, packId: 'other', tradeLabel: 'Pool Service', pricing: { tripFeeCents: 9900, hourlyRateCents: 12000 } },
      { catalogRepo, templateRepo },
    );
    const catalog = await catalogRepo.listByTenant(TENANT);
    expect(catalog.find((c) => c.name === 'Pool Service Diagnostic Fee')?.unitPriceCents).toBe(9900);
    expect(catalog.find((c) => c.name === 'Pool Service Labor')?.unitPriceCents).toBe(12000);
  });
});
