import { describe, it, expect } from 'vitest';
import {
  normalizeForMatch,
  singularizeToken,
  resolveLineItemToCatalog,
  resolveLineItems,
  applyCatalogPricing,
  TAU_HIGH,
  TAU_FLOOR,
  MARGIN,
  UNCATALOGUED_CONFIDENCE_CAP,
  CatalogLineResolution,
} from '../../../src/ai/resolution/catalog-resolver';
import { CatalogItem, createCatalogItem } from '../../../src/catalog/catalog-item';

const TENANT = 'tenant-1';

function item(
  name: string,
  unitPriceCents: number,
  overrides: Partial<Parameters<typeof createCatalogItem>[0]> = {},
): CatalogItem {
  return createCatalogItem({
    tenantId: TENANT,
    name,
    category: 'Labor',
    unit: 'each',
    unitPriceCents,
    ...overrides,
  });
}

describe('normalizeForMatch', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeForMatch('  Water-Heater   (Install)!! ')).toEqual([
      'water',
      'heater',
      'install',
    ]);
  });

  it('folds accents/diacritics', () => {
    expect(normalizeForMatch('Café drain açaí')).toEqual(['cafe', 'drain', 'acai']);
  });

  it('drops stopwords and single-char tokens', () => {
    expect(normalizeForMatch('a new filter for the unit')).toEqual(['new', 'filter', 'unit']);
  });

  it('drops digit-only tokens (quantities are not identity)', () => {
    expect(normalizeForMatch('2 hours labor')).toEqual(['hour', 'labor']);
  });

  it('returns [] for empty, whitespace, and symbol-only input', () => {
    expect(normalizeForMatch('')).toEqual([]);
    expect(normalizeForMatch('   ')).toEqual([]);
    expect(normalizeForMatch('!!! ### 🚚')).toEqual([]);
  });
});

describe('singularizeToken (trade-aware)', () => {
  it.each([
    ['fittings', 'fitting'],
    ['switches', 'switch'],
    ['assemblies', 'assembly'],
    ['boxes', 'box'],
    ['glasses', 'glass'],
    ['valves', 'valve'],
  ])('%s → %s', (input, expected) => {
    expect(singularizeToken(input)).toBe(expected);
  });

  it.each(['gas', 'brass', 'glass', 'status', 'bus', 'lens', 'chassis'])(
    'never corrupts singular trade term %s',
    (token) => {
      expect(singularizeToken(token)).toBe(token);
    },
  );
});

describe('resolveLineItemToCatalog — tiers', () => {
  const waterHeaterInstall = item('Water Heater Install', 185_000);
  const condenserCoil = item('Condenser Coil', 62_000, { category: 'Parts' });
  const catalog = [waterHeaterInstall, condenserCoil];

  it('exact normalized name match → exact tier with the item', () => {
    const r = resolveLineItemToCatalog('water heater install', catalog);
    expect(r.tier).toBe('exact');
    expect(r.match?.id).toBe(waterHeaterInstall.id);
  });

  it('exact match is case/punctuation/plural insensitive', () => {
    const r = resolveLineItemToCatalog('WATER-HEATER INSTALLS!', catalog);
    expect(r.tier).toBe('exact');
    expect(r.match?.id).toBe(waterHeaterInstall.id);
  });

  it('query prefix of catalog name → high tier', () => {
    const r = resolveLineItemToCatalog('water heater', catalog);
    expect(r.tier).toBe('high');
    expect(r.match?.id).toBe(waterHeaterInstall.id);
  });

  it('word-order variation (token multiset) → high tier', () => {
    const r = resolveLineItemToCatalog('coil condenser', catalog);
    expect(r.tier).toBe('high');
    expect(r.match?.id).toBe(condenserCoil.id);
  });

  it('transcription typo within Levenshtein budget → resolves ("condensor coil")', () => {
    const r = resolveLineItemToCatalog('condensor coil', catalog);
    expect(r.tier).toBe('high');
    expect(r.match?.id).toBe(condenserCoil.id);
  });

  it('"water heeter" fuzzy-matches the water heater item', () => {
    const r = resolveLineItemToCatalog('water heeter install', catalog);
    expect(r.tier).toBe('high');
    expect(r.match?.id).toBe(waterHeaterInstall.id);
  });

  it('garbage with no token hits → none', () => {
    expect(resolveLineItemToCatalog('xyzzy plugh', catalog).tier).toBe('none');
  });

  it('degenerate inputs never match: "", "  ", "x", short tokens', () => {
    for (const q of ['', '   ', 'x', 'ab', '🚚', '!!!']) {
      expect(resolveLineItemToCatalog(q, catalog).tier).toBe('none');
    }
  });

  it('empty catalog → none for any query', () => {
    expect(resolveLineItemToCatalog('water heater install', []).tier).toBe('none');
  });
});

describe('resolveLineItemToCatalog — ambiguity & tie-breakers', () => {
  it('two plausible items at different prices → ambiguous with both candidates', () => {
    const air = item('Air Filter', 2_000, { category: 'Parts' });
    const water = item('Water Filter', 3_500, { category: 'Parts' });
    const r = resolveLineItemToCatalog('filter', [air, water]);
    expect(r.tier).toBe('ambiguous');
    expect(r.candidates).toHaveLength(2);
    const ids = r.candidates!.map((c) => c.item.id);
    expect(ids).toContain(air.id);
    expect(ids).toContain(water.id);
  });

  it('tied candidates at IDENTICAL price → deterministic alphabetical winner, not ambiguous', () => {
    const a = item('Air Filter', 2_000, { category: 'Parts' });
    const b = item('Water Filter', 2_000, { category: 'Parts' });
    const r = resolveLineItemToCatalog('filter', [b, a]); // insertion order must not matter
    expect(r.tier).toBe('high');
    expect(r.match?.name).toBe('Air Filter'); // alphabetical
  });

  it('single weak match (floor ≤ score < TAU_HIGH) → ambiguous with one candidate, never silent', () => {
    // 2 of 3 query tokens hit, full name coverage → 2/3 ≈ 0.667: in band.
    const drainService = item('Drain Cleaning', 15_000);
    const r = resolveLineItemToCatalog('drain cleaning job', [drainService]);
    expect(r.tier).toBe('ambiguous');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates![0].score).toBeGreaterThanOrEqual(TAU_FLOOR);
    expect(r.candidates![0].score).toBeLessThan(TAU_HIGH);
  });

  it('clear margin over runner-up → best wins outright', () => {
    const install = item('Water Heater Install', 185_000);
    const unrelated = item('Drain Snake Rental', 4_000);
    const r = resolveLineItemToCatalog('water heater install', [install, unrelated]);
    expect(r.tier).toBe('exact');
    expect(r.match?.id).toBe(install.id);
  });

  it('runner-up within MARGIN at a different price → ambiguous', () => {
    // Both are prefix-matched by the query → identical 0.92 scores.
    const a = item('Water Heater Install Standard', 185_000);
    const b = item('Water Heater Install Premium', 285_000);
    const r = resolveLineItemToCatalog('water heater install', [a, b]);
    expect(r.tier).toBe('ambiguous');
    expect(r.candidates!.length).toBe(2);
    // Sanity: the constants this behavior depends on are pinned.
    expect(MARGIN).toBe(0.15);
  });

  it('caps ambiguous candidates at 3', () => {
    const items = ['Air Filter', 'Water Filter', 'Oil Filter', 'Fuel Filter'].map((n, i) =>
      item(n, 1_000 * (i + 1), { category: 'Parts' }),
    );
    const r = resolveLineItemToCatalog('filter', items);
    expect(r.tier).toBe('ambiguous');
    expect(r.candidates!.length).toBe(3);
  });
});

describe('description matching', () => {
  it('matches on description at reduced weight when the name misses', () => {
    const it1 = item('SVC-104', 9_500, {
      description: 'Annual furnace tune up and inspection',
    });
    const r = resolveLineItemToCatalog('annual furnace tune up and inspection', [it1]);
    // Description evidence alone is capped at DESCRIPTION_WEIGHT (0.6) —
    // enough to surface as a candidate, never enough to auto-price.
    expect(r.tier).toBe('ambiguous');
    expect(r.candidates![0].item.id).toBe(it1.id);
  });
});

describe('resolveLineItems', () => {
  it('resolves each query independently and preserves order', () => {
    const heater = item('Water Heater Install', 185_000);
    const results = resolveLineItems(['water heater install', 'mystery widget'], [heater]);
    expect(results).toHaveLength(2);
    expect(results[0].tier).toBe('exact');
    expect(results[1].tier).toBe('none');
  });
});

describe('applyCatalogPricing', () => {
  const heater = item('Water Heater Install', 185_000);

  function resolved(match: CatalogItem): CatalogLineResolution {
    return { query: match.name, tier: 'high', match };
  }

  it('overwrites the LLM price with the catalog price (unitPriceCents mode) and recomputes totalCents', () => {
    const out = applyCatalogPricing(
      [{ description: 'Water Heater Install', quantity: 2, unitPriceCents: 99_900, totalCents: 199_800 }],
      [resolved(heater)],
      'unitPriceCents',
    );
    expect(out.lineItems[0]).toMatchObject({
      unitPriceCents: 185_000,
      totalCents: 370_000,
      catalogItemId: heater.id,
      pricingSource: 'catalog',
      category: 'labor',
    });
    expect(out.anyCatalogPriced).toBe(true);
    expect(out.anyUncatalogued).toBe(false);
    expect(out.missingFields).toEqual([]);
  });

  it('writes the catalog price into unitPrice in estimate mode', () => {
    const out = applyCatalogPricing(
      [{ description: 'Water Heater Install', quantity: 1, unitPrice: 12_345 }],
      [resolved(heater)],
      'unitPrice',
    );
    expect(out.lineItems[0]).toMatchObject({
      unitPrice: 185_000,
      catalogItemId: heater.id,
      pricingSource: 'catalog',
    });
    expect(out.lineItems[0]).not.toHaveProperty('totalCents');
  });

  it('maps Parts/Materials categories to material', () => {
    const coil = item('Condenser Coil', 62_000, { category: 'Parts' });
    const out = applyCatalogPricing(
      [{ description: 'Condenser Coil', quantity: 1, unitPriceCents: 1 }],
      [resolved(coil)],
      'unitPriceCents',
    );
    expect(out.lineItems[0].category).toBe('material');
  });

  it('ambiguous line keeps the LLM price, records candidates + missing field', () => {
    const air = item('Air Filter', 2_000, { category: 'Parts' });
    const water = item('Water Filter', 3_500, { category: 'Parts' });
    const ambiguous: CatalogLineResolution = {
      query: 'filter',
      tier: 'ambiguous',
      candidates: [
        { item: air, score: 0.77, matchType: 'token_overlap' },
        { item: water, score: 0.77, matchType: 'token_overlap' },
      ],
    };
    const out = applyCatalogPricing(
      [{ description: 'filter', quantity: 1, unitPriceCents: 2_500 }],
      [ambiguous],
      'unitPriceCents',
    );
    expect(out.lineItems[0]).toMatchObject({ unitPriceCents: 2_500, pricingSource: 'ambiguous' });
    expect(out.missingFields).toEqual(['lineItems[0].catalogItemId']);
    expect(out.catalogResolution![0]).toEqual([
      { id: air.id, name: 'Air Filter', unitPriceCents: 2_000, score: 0.77 },
      { id: water.id, name: 'Water Filter', unitPriceCents: 3_500, score: 0.77 },
    ]);
  });

  it('uncatalogued line keeps the LLM price and sets the flag', () => {
    const out = applyCatalogPricing(
      [{ description: 'mystery widget', quantity: 1, unitPriceCents: 4_200 }],
      [{ query: 'mystery widget', tier: 'none' }],
      'unitPriceCents',
    );
    expect(out.lineItems[0]).toMatchObject({ unitPriceCents: 4_200, pricingSource: 'uncatalogued' });
    expect(out.anyUncatalogued).toBe(true);
    expect(out.anyCatalogPriced).toBe(false);
  });

  it('mixed lines: indices in missingFields line up with their items', () => {
    const air = item('Air Filter', 2_000, { category: 'Parts' });
    const out = applyCatalogPricing(
      [
        { description: 'Water Heater Install', quantity: 1, unitPriceCents: 1 },
        { description: 'filter', quantity: 1, unitPriceCents: 2 },
        { description: 'mystery widget', quantity: 1, unitPriceCents: 3 },
      ],
      [
        resolved(heater),
        {
          query: 'filter',
          tier: 'ambiguous',
          candidates: [{ item: air, score: 0.7, matchType: 'token_overlap' }],
        },
        { query: 'mystery widget', tier: 'none' },
      ],
      'unitPriceCents',
    );
    expect(out.missingFields).toEqual(['lineItems[1].catalogItemId']);
    expect(out.anyCatalogPriced).toBe(true);
    expect(out.anyUncatalogued).toBe(true);
  });

  it('the uncatalogued confidence cap sits below the 0.9 auto-approve threshold', () => {
    expect(UNCATALOGUED_CONFIDENCE_CAP).toBeLessThan(0.9);
  });
});
