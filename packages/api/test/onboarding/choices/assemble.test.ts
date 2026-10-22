import { describe, it, expect } from 'vitest';
import { assembleTypicalShop, renderTemplate } from '../../../src/onboarding/choices/assemble';
import { packDefaultTiers, type RegionalPriceTierRepository, type RegionalPriceTiers } from '../../../src/onboarding/choices/price-tiers';
import { CHOICE_KEYS } from '../../../src/onboarding/choices/schema';

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

describe('renderTemplate', () => {
  it('substitutes known tokens and leaves no braces behind', () => {
    const out = renderTemplate('{businessName} charges {tripFee} then {hourlyRate} in {city}, says {ownerFirstName}', {
      businessName: 'Walsh Plumbing',
      tripFee: '$89',
      hourlyRate: '$150',
      city: 'Cleveland',
      ownerFirstName: 'Jenna',
    });
    expect(out).toBe('Walsh Plumbing charges $89 then $150 in Cleveland, says Jenna');
    expect(out).not.toMatch(/[{}]/);
  });
  it('throws on an unknown token rather than speaking a brace to a caller', () => {
    expect(() => renderTemplate('hi {nope}', { businessName: 'x', tripFee: '', hourlyRate: '', city: '', ownerFirstName: '' })).toThrow(/nope/);
  });
});

describe('assembleTypicalShop', () => {
  const repo = new InMemoryTierRepo({ 'plumbing|CLE': CLE });

  it('builds a plumbing shop for Cleveland from the metro tier, with every token rendered', async () => {
    const shop = await assembleTypicalShop(repo, {
      packId: 'plumbing',
      businessName: 'Walsh Plumbing',
      ownerFirstName: 'Jenna',
      metro: { kind: 'metro', metroCode: 'CLE', name: 'Cleveland' },
    });
    expect(shop.trade).toBe('plumbing');
    expect(shop.metroCode).toBe('CLE');
    expect(shop.metroName).toBe('Cleveland');
    expect(shop.priceSource).toBe('metro');
    expect(shop.showsCity).toBe(true);

    const keys = shop.choices.map((c) => c.settingKey);
    for (const k of CHOICE_KEYS) expect(keys).toContain(k);
    expect(keys).toContain('existing_number');

    for (const c of shop.choices) {
      expect(c.explain, `${c.settingKey} explains itself`).toBeTruthy();
      expect(c.example, `${c.settingKey} has an example`).toBeTruthy();
      for (const text of [c.question, c.supportLine ?? '', c.explain ?? '', c.example ?? '', ...c.options.flatMap((o) => [o.label, o.detail ?? '', o.rivetLine])]) {
        expect(text, `${c.settingKey}: ${text}`).not.toMatch(/[{}]/);
      }
    }
    const greeting = shop.choices.find((c) => c.settingKey === 'greeting')!;
    expect(greeting.options[0].rivetLine).toBe('Walsh Plumbing, how can I help?');
    expect(greeting.options[0].writes.voiceGreeting).toBe('Walsh Plumbing, how can I help?');
  });

  it('prices option a from the standard tier and option b from premium, as whole dollars', async () => {
    const shop = await assembleTypicalShop(repo, {
      packId: 'plumbing',
      businessName: 'Walsh Plumbing',
      metro: { kind: 'metro', metroCode: 'CLE', name: 'Cleveland' },
    });
    const price = shop.choices.find((c) => c.settingKey === 'trip_fee_and_rate')!;
    expect(price.options[0].prices).toEqual(CLE.standard);
    expect(price.options[1].prices).toEqual(CLE.premium);
    expect(price.options[0].label).toBe('$89 to come out, then $150 an hour');
    expect(price.options[1].label).toBe('$129 to come out, then $185 an hour');
    expect(price.options[0].rivetLine).toContain('$89');
    expect(price.supportLine).toContain('Cleveland');
    // "Give me an example" quotes the usual (standard) trip fee, and says what the second card does.
    expect(price.example).toContain("With the first, I say it's $89 for the visit");
    expect(price.example).toContain('With the second, I quote the higher fee');
    for (const c of shop.choices) {
      if (c.settingKey !== 'trip_fee_and_rate') {
        for (const o of c.options) expect(o.prices).toBeUndefined();
      }
    }
  });

  it('falls back to pack defaults and "your area" when the metro is unknown', async () => {
    const shop = await assembleTypicalShop(repo, {
      packId: 'hvac',
      businessName: 'M&R Mechanical',
      metro: { kind: 'unknown' },
    });
    expect(shop.metroCode).toBeNull();
    expect(shop.metroName).toBeNull();
    expect(shop.priceSource).toBe('pack_default');
    expect(shop.showsCity).toBe(false);
    const price = shop.choices.find((c) => c.settingKey === 'trip_fee_and_rate')!;
    expect(price.options[0].prices).toEqual(packDefaultTiers('hvac').standard);
    expect(price.supportLine).toContain('your area');
    expect(price.supportLine).not.toContain('Cleveland');
  });

  it('treats an ambiguous metro as unknown for pricing and surfaces the candidates', async () => {
    const shop = await assembleTypicalShop(repo, {
      packId: 'plumbing',
      businessName: 'Walsh Plumbing',
      metro: { kind: 'ambiguous', metros: [{ metroCode: 'CLE', name: 'Cleveland' }, { metroCode: 'AKR', name: 'Akron' }] },
    });
    expect(shop.metroCode).toBeNull();
    expect(shop.metroCandidates).toEqual([
      { metroCode: 'CLE', name: 'Cleveland' },
      { metroCode: 'AKR', name: 'Akron' },
    ]);
    expect(shop.showsCity).toBe(false);
  });

  it('uses "the owner" when no first name is known and marks defaults from mostShops', async () => {
    const shop = await assembleTypicalShop(repo, {
      packId: 'electrical',
      businessName: 'Bright Electric',
      metro: null,
    });
    const booking = shop.choices.find((c) => c.settingKey === 'booking_posture')!;
    expect(booking.options[1].rivetLine).toContain('the owner');
    for (const c of shop.choices) expect(shop.defaults[c.settingKey]).toBe(c.mostShops);
  });

  it('formats cents as whole dollars when even and with cents otherwise', async () => {
    const odd = new InMemoryTierRepo({
      'plumbing|CLE': { standard: { tripFeeCents: 8950, hourlyRateCents: 15000 }, premium: CLE.premium },
    });
    const shop = await assembleTypicalShop(odd, {
      packId: 'plumbing',
      businessName: 'Walsh Plumbing',
      metro: { kind: 'metro', metroCode: 'CLE', name: 'Cleveland' },
    });
    const price = shop.choices.find((c) => c.settingKey === 'trip_fee_and_rate')!;
    expect(price.options[0].label).toBe('$89.50 to come out, then $150 an hour');
  });
});
