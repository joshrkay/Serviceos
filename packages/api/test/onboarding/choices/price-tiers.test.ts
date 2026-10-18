import { describe, it, expect } from 'vitest';
import {
  PREMIUM_MULTIPLIER_BPS,
  RegionalPriceTiersSchema,
  packDefaultTiers,
  resolvePriceTiers,
  scaleCentsBps,
  type RegionalPriceTierRepository,
  type RegionalPriceTiers,
} from '../../../src/onboarding/choices/price-tiers';
import { PLUMBING_LINE_ITEM_DEFAULTS } from '../../../src/verticals/packs/plumbing';
import { HVAC_LINE_ITEM_DEFAULTS } from '../../../src/verticals/packs/hvac';

class InMemoryTierRepo implements RegionalPriceTierRepository {
  constructor(private readonly rows: Record<string, RegionalPriceTiers>) {}
  async find(trade: string, metroCode: string): Promise<RegionalPriceTiers | null> {
    return this.rows[`${trade}|${metroCode}`] ?? null;
  }
}

const CLE: RegionalPriceTiers = {
  standard: { tripFeeCents: 8900, hourlyRateCents: 15000 },
  premium: { tripFeeCents: 12900, hourlyRateCents: 18500 },
};
const US: RegionalPriceTiers = {
  standard: { tripFeeCents: 7900, hourlyRateCents: 13500 },
  premium: { tripFeeCents: 11900, hourlyRateCents: 17500 },
};

describe('scaleCentsBps', () => {
  it('scales integer cents by basis points and rounds to the nearest dollar', () => {
    expect(scaleCentsBps(7500, 13000)).toBe(9800); // 97.50 → 98
    expect(scaleCentsBps(11500, 13000)).toBe(15000); // 149.50 → 150 (half up)
    expect(scaleCentsBps(10000, 10000)).toBe(10000);
  });
  it('never returns a non-integer or a negative', () => {
    expect(Number.isInteger(scaleCentsBps(12345, 13333))).toBe(true);
    expect(scaleCentsBps(0, 13000)).toBe(0);
    expect(() => scaleCentsBps(-1, 10000)).toThrow();
    expect(() => scaleCentsBps(100.5, 10000)).toThrow();
  });
});

describe('packDefaultTiers', () => {
  it('derives plumbing standard from the pack line-item defaults and premium by the multiplier', () => {
    const t = packDefaultTiers('plumbing');
    expect(t.standard).toEqual({
      tripFeeCents: PLUMBING_LINE_ITEM_DEFAULTS.diagnosticFeeCents,
      hourlyRateCents: PLUMBING_LINE_ITEM_DEFAULTS.laborRatePerHourCents,
    });
    expect(t.premium.tripFeeCents).toBe(scaleCentsBps(PLUMBING_LINE_ITEM_DEFAULTS.diagnosticFeeCents, PREMIUM_MULTIPLIER_BPS));
    expect(t.premium.hourlyRateCents).toBe(scaleCentsBps(PLUMBING_LINE_ITEM_DEFAULTS.laborRatePerHourCents, PREMIUM_MULTIPLIER_BPS));
  });
  it('derives hvac from its own defaults', () => {
    const t = packDefaultTiers('hvac');
    expect(t.standard.tripFeeCents).toBe(HVAC_LINE_ITEM_DEFAULTS.diagnosticFeeCents);
    expect(t.standard.hourlyRateCents).toBe(HVAC_LINE_ITEM_DEFAULTS.laborRatePerHourCents);
  });
  it('gives any other pack id the generic defaults and still validates', () => {
    for (const id of ['electrical', 'roofing', 'other', 'nonsense']) {
      expect(() => RegionalPriceTiersSchema.parse(packDefaultTiers(id))).not.toThrow();
    }
  });
});

describe('resolvePriceTiers', () => {
  const repo = new InMemoryTierRepo({ 'plumbing|CLE': CLE, 'plumbing|US': US });

  it('uses the metro row when present and says the city may be shown', async () => {
    const r = await resolvePriceTiers(repo, 'plumbing', 'CLE');
    expect(r).toEqual({ tiers: CLE, source: 'metro', showsCity: true });
  });
  it('falls back to the national row when the metro has none', async () => {
    const r = await resolvePriceTiers(repo, 'plumbing', 'DEN');
    expect(r).toEqual({ tiers: US, source: 'national', showsCity: false });
  });
  it('falls back to pack defaults when no rows exist for the trade', async () => {
    const r = await resolvePriceTiers(repo, 'hvac', 'CLE');
    expect(r.source).toBe('pack_default');
    expect(r.showsCity).toBe(false);
    expect(r.tiers).toEqual(packDefaultTiers('hvac'));
  });
  it('skips the metro lookup when the metro is unknown', async () => {
    const r = await resolvePriceTiers(repo, 'plumbing', null);
    expect(r).toEqual({ tiers: US, source: 'national', showsCity: false });
  });
  it('rejects a repository row that is not integer cents', async () => {
    const bad = new InMemoryTierRepo({
      'plumbing|CLE': { standard: { tripFeeCents: 89.5, hourlyRateCents: 150 }, premium: CLE.premium },
    });
    await expect(resolvePriceTiers(bad, 'plumbing', 'CLE')).rejects.toThrow();
  });
});
