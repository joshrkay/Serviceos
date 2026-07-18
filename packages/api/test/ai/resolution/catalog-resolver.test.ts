import { describe, it, expect } from 'vitest';
import {
  normalizeForMatch,
  normalizeForMatchKeepDigits,
  singularizeToken,
  resolveLineItemToCatalog,
  resolveLineItems,
  applyCatalogPricing,
  groundLineItemPricing,
  TAU_HIGH,
  TAU_FLOOR,
  MARGIN,
  UNCATALOGUED_CONFIDENCE_CAP,
  PRICE_CONFLICT_MIN_REL,
  PRICE_CONFLICT_MIN_ABS_CENTS,
  CatalogLineResolution,
} from '../../../src/ai/resolution/catalog-resolver';
import { CatalogItem, createCatalogItem } from '../../../src/catalog/catalog-item';
import { decideInitialStatus } from '../../../src/proposals/proposal';
import type { ProposalConfidenceMeta } from '../../../src/proposals/contracts';

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

describe('normalizeForMatchKeepDigits', () => {
  it('KEEPS digit-only tokens (SKU identity), unlike normalizeForMatch', () => {
    expect(normalizeForMatchKeepDigits('Part 120')).toEqual(['part', '120']);
    // The digit-dropping normalizer collapses the same input to just 'part'.
    expect(normalizeForMatch('Part 120')).toEqual(['part']);
  });

  it('still drops stopwords and sub-2-char tokens, folds accents, singularizes', () => {
    // 'a' stopword, '2' sub-2-char dropped; 'filters' singularized.
    expect(normalizeForMatchKeepDigits('a 2 café filters')).toEqual(['cafe', 'filter']);
  });

  it('preserves multi-digit SKU tokens distinctly (12 ≠ 012)', () => {
    expect(normalizeForMatchKeepDigits('part 12').join(' ')).toBe('part 12');
    expect(normalizeForMatchKeepDigits('Part 012').join(' ')).toBe('part 012');
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

describe('resolveLineItemToCatalog — digit-aware SKU pass (numbered families)', () => {
  // A numbered catalog family: every name digit-DROP-normalizes to just
  // 'part', so without the digit-aware pass they are mutually ambiguous and
  // the named item is unreachable from a MAX_CANDIDATES=3 picker.
  const family = Array.from({ length: 180 }, (_, i) =>
    item(`Part ${String(i).padStart(3, '0')}`, 100 + i, { category: 'Parts' }),
  );

  it('a unique digit-aware match resolves to exact tier with the named item', () => {
    const r = resolveLineItemToCatalog('part 120', family);
    expect(r.tier).toBe('exact');
    expect(r.match?.name).toBe('Part 120');
    expect(r.match?.unitPriceCents).toBe(220); // 100 + 120
  });

  it('a digit-aware exact match still honors the price-conflict carve-out (not a silent snap)', () => {
    const r = resolveLineItemToCatalog('part 120', family);
    expect(r.tier).toBe('exact');
    // The resolver returns the exact item; the "did you mean" conflict check
    // lives in applyCatalogPricing. A ≥10% + ≥$1 spoken-price deviation must
    // still surface the two conflict candidates rather than snapping.
    const out = applyCatalogPricing(
      [{ description: 'part 120', quantity: 1, unitPriceCents: 500 }],
      [r],
      'unitPriceCents',
    );
    expect(out.lineItems[0]).toMatchObject({
      unitPriceCents: 500, // spoken price preserved, NOT snapped to 220
      pricingSource: 'ambiguous',
      needsPricing: true,
    });
    expect(out.catalogResolution![0]).toEqual([
      { id: r.match!.id, name: 'Part 120', unitPriceCents: 220, score: 1, category: 'material' },
      { id: 'spoken:0', name: 'Keep spoken price', unitPriceCents: 500, score: 0 },
    ]);
    expect(out.requiresReview).toBe(true);
  });

  it('a digit-aware exact match with an in-tolerance price snaps to the catalog price', () => {
    const r = resolveLineItemToCatalog('part 120', family);
    const out = applyCatalogPricing(
      [{ description: 'part 120', quantity: 1, unitPriceCents: 230 }], // within 100¢ of 220
      [r],
      'unitPriceCents',
    );
    expect(out.lineItems[0]).toMatchObject({
      unitPriceCents: 220,
      catalogItemId: r.match!.id,
      pricingSource: 'catalog',
      needsPricing: false,
    });
  });

  it('the bare family stem ("part", no digits) is still genuinely ambiguous', () => {
    const r = resolveLineItemToCatalog('part', family);
    expect(r.tier).toBe('ambiguous');
    expect(r.candidates!.length).toBe(3); // MAX_CANDIDATES preserved
  });

  it('a mismatched SKU number does not collide (12 ≠ 012) — falls through to ambiguous', () => {
    // 'part 12' keeps ['part','12']; no family name normalizes to 'part 12'
    // (they are zero-padded 'part 0NN'), so the digit-aware pass finds zero
    // matches and the digit-dropping path treats it as the ambiguous stem.
    const r = resolveLineItemToCatalog('part 12', family);
    expect(r.tier).toBe('ambiguous');
  });

  it('a quantity phrase never false-positives through the digit pass', () => {
    const hvacFilter = item('HVAC Filter', 4_500, { category: 'Parts' });
    // '12' is a real digit token, so the digit-aware pass runs — but it
    // requires the FULL string to match, and 'part 12 hvac filter' ≠
    // 'hvac filter', so it can't snap. Falls through to the ordinary path.
    const r = resolveLineItemToCatalog('add 12 hvac filters', [hvacFilter]);
    expect(r.tier).not.toBe('exact');
  });

  it('quantity robustness preserved: "2 gaskets" still snaps to "Gasket"', () => {
    const gasket = item('Gasket', 450, { category: 'Parts' });
    // '2' is sub-2-char and dropped from BOTH normalizers, so no digit token
    // survives → the digit-aware pass is skipped and the digit-dropping path
    // exact-matches the singularized 'gasket'.
    const r = resolveLineItemToCatalog('2 gaskets', [gasket]);
    expect(r.tier).toBe('exact');
    expect(r.match?.id).toBe(gasket.id);
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
    // Deviation is within tolerance (transcription noise, not a deliberate
    // custom quote) — this is the ordinary snap-to-catalog path, not a
    // price conflict; see the `applyCatalogPricing — price conflict` block
    // below for the deliberately-large-deviation "did you mean" path.
    const out = applyCatalogPricing(
      [{ description: 'Water Heater Install', quantity: 2, unitPriceCents: 184_500, totalCents: 369_000 }],
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
      [{ description: 'Water Heater Install', quantity: 1, unitPrice: 184_000 }],
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
      [{ description: 'Condenser Coil', quantity: 1, unitPriceCents: 61_950 }],
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
      { id: air.id, name: 'Air Filter', unitPriceCents: 2_000, score: 0.77, category: 'material' },
      { id: water.id, name: 'Water Filter', unitPriceCents: 3_500, score: 0.77, category: 'material' },
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
        { description: 'Water Heater Install', quantity: 1, unitPriceCents: 184_900 },
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

  it('uncatalogued line sets requiresReview (structural hard gate)', () => {
    const out = applyCatalogPricing(
      [{ description: 'mystery widget', quantity: 1, unitPriceCents: 4_200 }],
      [{ query: 'mystery widget', tier: 'none' }],
      'unitPriceCents',
    );
    expect(out.requiresReview).toBe(true);
  });

  it('ambiguous line also sets requiresReview', () => {
    const air = item('Air Filter', 2_000, { category: 'Parts' });
    const water = item('Water Filter', 3_500, { category: 'Parts' });
    const out = applyCatalogPricing(
      [{ description: 'filter', quantity: 1, unitPriceCents: 2_500 }],
      [
        {
          query: 'filter',
          tier: 'ambiguous',
          candidates: [
            { item: air, score: 0.77, matchType: 'token_overlap' },
            { item: water, score: 0.77, matchType: 'token_overlap' },
          ],
        },
      ],
      'unitPriceCents',
    );
    expect(out.requiresReview).toBe(true);
  });

  it('a clean catalog match does NOT set requiresReview', () => {
    const out = applyCatalogPricing(
      [{ description: 'Water Heater Install', quantity: 1, unitPriceCents: 184_900 }],
      [resolved(heater)],
      'unitPriceCents',
    );
    expect(out.requiresReview).toBe(false);
  });
});

describe('applyCatalogPricing — price conflict ("did you mean")', () => {
  const heater = item('Water Heater Install', 15_000);

  function resolved(match: CatalogItem): CatalogLineResolution {
    return { query: match.name, tier: 'high', match };
  }

  it('a large deviation (both thresholds exceeded) surfaces a "did you mean" instead of snapping', () => {
    const out = applyCatalogPricing(
      [{ description: 'Water Heater Install', quantity: 1, unitPriceCents: 7_500 }],
      [resolved(heater)],
      'unitPriceCents',
    );
    expect(out.lineItems[0]).toMatchObject({
      description: 'Water Heater Install',
      unitPriceCents: 7_500, // the spoken price is preserved, NOT overwritten
      pricingSource: 'ambiguous',
      needsPricing: true,
    });
    expect(out.lineItems[0]).not.toHaveProperty('catalogItemId');
    expect(out.missingFields).toEqual(['lineItems[0].catalogItemId']);
    expect(out.catalogResolution![0]).toEqual([
      {
        id: heater.id,
        name: 'Water Heater Install',
        unitPriceCents: 15_000,
        score: 1,
        category: 'labor',
      },
      { id: 'spoken:0', name: 'Keep spoken price', unitPriceCents: 7_500, score: 0 },
    ]);
    expect(out.anyCatalogPriced).toBe(false);
    expect(out.requiresReview).toBe(true);
  });

  it('a small deviation (below both thresholds) snaps to catalog exactly as before', () => {
    const out = applyCatalogPricing(
      [{ description: 'Water Heater Install', quantity: 1, unitPriceCents: 14_900 }],
      [resolved(heater)],
      'unitPriceCents',
    );
    expect(out.lineItems[0]).toMatchObject({
      unitPriceCents: 15_000,
      catalogItemId: heater.id,
      pricingSource: 'catalog',
    });
    expect(out.catalogResolution).toBeUndefined();
    expect(out.anyCatalogPriced).toBe(true);
    expect(out.requiresReview).toBe(false);
  });

  it('a price-less line with an exact/high match snaps to catalog unchanged', () => {
    const out = applyCatalogPricing(
      [{ description: 'Water Heater Install', quantity: 1 }],
      [resolved(heater)],
      'unitPriceCents',
    );
    expect(out.lineItems[0]).toMatchObject({
      unitPriceCents: 15_000,
      catalogItemId: heater.id,
      pricingSource: 'catalog',
    });
    expect(out.anyCatalogPriced).toBe(true);
  });

  it('a zero-cent (comped) price is a REAL drafted price — surfaces a conflict, not a snap to full price', () => {
    const out = applyCatalogPricing(
      [{ description: 'Water Heater Install', quantity: 1, unitPriceCents: 0 }],
      [resolved(heater)],
      'unitPriceCents',
    );
    expect(out.lineItems[0]).toMatchObject({
      unitPriceCents: 0,
      pricingSource: 'ambiguous',
      needsPricing: true,
    });
    expect(out.catalogResolution![0]).toEqual([
      {
        id: heater.id,
        name: 'Water Heater Install',
        unitPriceCents: 15_000,
        score: 1,
        category: 'labor',
      },
      { id: 'spoken:0', name: 'Keep spoken price', unitPriceCents: 0, score: 0 },
    ]);
    expect(out.requiresReview).toBe(true);
  });

  it('a zero-cent price against a sub-$1 catalog item still snaps (below the absolute threshold)', () => {
    const washer = item('Washer', 80);
    const out = applyCatalogPricing(
      [{ description: 'Washer', quantity: 1, unitPriceCents: 0 }],
      [resolved(washer)],
      'unitPriceCents',
    );
    expect(out.lineItems[0]).toMatchObject({
      unitPriceCents: 80,
      catalogItemId: washer.id,
      pricingSource: 'catalog',
    });
    expect(out.requiresReview).toBe(false);
  });

  it('a non-integer price never triggers a conflict — snaps to catalog', () => {
    const out = applyCatalogPricing(
      [{ description: 'Water Heater Install', quantity: 1, unitPriceCents: 7_500.5 }],
      [resolved(heater)],
      'unitPriceCents',
    );
    expect(out.lineItems[0]).toMatchObject({
      unitPriceCents: 15_000,
      catalogItemId: heater.id,
      pricingSource: 'catalog',
    });
  });

  it('deviation large in % but under the absolute-cents floor still snaps (small-dollar line)', () => {
    const cheapItem = item('Filter Swap', 500);
    const out = applyCatalogPricing(
      [{ description: 'Filter Swap', quantity: 1, unitPriceCents: 420 }],
      [{ query: 'Filter Swap', tier: 'high', match: cheapItem }],
      'unitPriceCents',
    );
    // |500-420| = 80% relative deviation, well over PRICE_CONFLICT_MIN_REL,
    // but the 80-cent absolute gap is under PRICE_CONFLICT_MIN_ABS_CENTS —
    // real-money risk is negligible, so it snaps rather than interrupting.
    expect(out.lineItems[0]).toMatchObject({
      unitPriceCents: 500,
      catalogItemId: cheapItem.id,
      pricingSource: 'catalog',
    });
    expect(out.requiresReview).toBe(false);
  });

  it('threshold constants are pinned', () => {
    expect(PRICE_CONFLICT_MIN_REL).toBe(0.1);
    expect(PRICE_CONFLICT_MIN_ABS_CENTS).toBe(100);
  });
});

describe('groundLineItemPricing — requiresReview hard gate', () => {
  const heater = item('Water Heater Install', 185_000);

  it('(a) uncatalogued line forces draft even when a tenant lowers the auto-approve threshold to 0.5', async () => {
    const outcome = await groundLineItemPricing(
      [{ description: 'mystery widget', quantity: 1, unitPriceCents: 4_200 }],
      'unitPriceCents',
      () => Promise.resolve([heater]), // catalog is wired and non-empty; the line just isn't in it
    );
    expect(outcome.requiresReview).toBe(true);
    expect(outcome.anyUncatalogued).toBe(true);

    // Mirror exactly what every real consumer (invoice-task.ts, estimate-task.ts,
    // mms-estimate-task.ts, create-voice-turn-processor.ts) does with the
    // outcome: stamp payload._meta.overallConfidence = 'low' whenever
    // requiresReview is true. This is the RV-007 confidence-marker guard,
    // which `decideInitialStatus` checks via `confidenceMetaBlocksAutoApprove`
    // BEFORE resolving any tenant threshold override.
    const meta: ProposalConfidenceMeta = {
      overallConfidence: outcome.requiresReview ? 'low' : 'high',
    };
    const status = decideInitialStatus({
      proposalType: 'draft_invoice',
      sourceTrustTier: 'autonomous',
      supervisorMode: 'both',
      // Even a high numeric confidence score (well above a threshold the
      // tenant has overridden down to 0.5) must not auto-approve.
      confidenceScore: UNCATALOGUED_CONFIDENCE_CAP,
      payload: { _meta: meta },
      tenantThresholdOverride: { both: 0.5 },
    });
    expect(status).toBe('draft');
  });

  it('(b) an exact/high catalog match is still auto-approvable as before', async () => {
    const outcome = await groundLineItemPricing(
      [{ description: 'Water Heater Install', quantity: 1, unitPriceCents: 184_900 }],
      'unitPriceCents',
      () => Promise.resolve([heater]),
    );
    expect(outcome.requiresReview).toBe(false);
    expect(outcome.anyUncatalogued).toBe(false);

    const meta: ProposalConfidenceMeta = {
      overallConfidence: outcome.requiresReview ? 'low' : 'high',
    };
    const status = decideInitialStatus({
      proposalType: 'draft_invoice',
      sourceTrustTier: 'autonomous',
      supervisorMode: 'both',
      confidenceScore: 0.95,
      payload: { _meta: meta },
      tenantThresholdOverride: { both: 0.5 },
    });
    expect(status).toBe('approved');
  });

  it('(c) an empty-catalog tenant forces requiresReview for every priced line', async () => {
    const outcome = await groundLineItemPricing(
      [
        { description: 'Water Heater Install', quantity: 1, unitPriceCents: 1 },
        { description: 'mystery widget', quantity: 1, unitPriceCents: 2 },
      ],
      'unitPriceCents',
      () => Promise.resolve([]), // catalog wired but empty (brand-new tenant)
    );
    expect(outcome.requiresReview).toBe(true);
    expect(outcome.anyUncatalogued).toBe(true);
    expect(outcome.lineItems.every((li) => li.pricingSource === 'uncatalogued')).toBe(true);
  });

  it('no catalog repo wired at all → requiresReview forced true', async () => {
    const outcome = await groundLineItemPricing(
      [{ description: 'Water Heater Install', quantity: 1, unitPriceCents: 1 }],
      'unitPriceCents',
      null,
    );
    expect(outcome.requiresReview).toBe(true);
  });

  it('empty line-item list → requiresReview false (no money risk)', async () => {
    const outcome = await groundLineItemPricing([], 'unitPriceCents', () => Promise.resolve([heater]));
    expect(outcome.requiresReview).toBe(false);
  });
});
