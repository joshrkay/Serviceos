/**
 * P22-001 — pure catalog resolution tests.
 *
 * The resolver matches LLM-extracted ("spoken") line items against the
 * tenant catalog. A spoken item resolves ONLY on a single unambiguous
 * candidate; anything else stays unresolved (never guessed).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveSpokenLineItems,
  buildCatalogPromptSection,
  normalizeForMatch,
  CATALOG_PROMPT_ITEM_CAP,
  ResolvableCatalogItem,
} from '../../../src/ai/tasks/catalog-resolution';

function item(id: string, name: string, unitPriceCents: number): ResolvableCatalogItem {
  return { id, name, unitPriceCents, unit: 'each', category: 'Parts' };
}

const CATALOG: ResolvableCatalogItem[] = [
  { id: 'c-service-call', name: 'Service Call', unitPriceCents: 12500, unit: 'each', category: 'Labor' },
  item('c-gasket', 'Gasket', 450),
  item('c-valve-ball', 'Ball Valve', 3200),
  item('c-valve-gate', 'Gate Valve', 4100),
  item('c-valve-check', 'Check Valve', 3900),
  item('c-wh-install', 'Water Heater Install', 85000),
];

describe('P22-001 catalog-resolution', () => {
  it('resolves "service call + three gaskets" with exact catalog prices', () => {
    const { resolved, unresolved } = resolveSpokenLineItems(
      [
        { description: 'service call' },
        { description: 'gaskets', quantity: 3 },
      ],
      CATALOG,
    );

    expect(unresolved).toHaveLength(0);
    expect(resolved).toHaveLength(2);

    const serviceCall = resolved.find((r) => r.catalogItemId === 'c-service-call');
    expect(serviceCall).toMatchObject({
      description: 'Service Call',
      quantity: 1, // defaults to 1 when unstated
      unitPriceCents: 12500,
    });

    const gaskets = resolved.find((r) => r.catalogItemId === 'c-gasket');
    expect(gaskets).toMatchObject({
      description: 'Gasket',
      quantity: 3,
      unitPriceCents: 450,
    });
  });

  it('leaves an ambiguous item ("valve" matches 3 valve SKUs) unresolved — never guesses', () => {
    const { resolved, unresolved } = resolveSpokenLineItems(
      [{ description: 'valve', quantity: 2 }],
      CATALOG,
    );
    expect(resolved).toHaveLength(0);
    expect(unresolved).toEqual([{ description: 'valve', quantity: 2 }]);
  });

  it('leaves an unknown item unresolved', () => {
    const { resolved, unresolved } = resolveSpokenLineItems(
      [{ description: 'unicorn polish' }],
      CATALOG,
    );
    expect(resolved).toHaveLength(0);
    expect(unresolved).toEqual([{ description: 'unicorn polish' }]);
  });

  it('prefers an exact normalized match over fuzzy containment candidates', () => {
    // "ball valve" exactly matches Ball Valve even though "valve" alone
    // would be ambiguous across three SKUs.
    const { resolved, unresolved } = resolveSpokenLineItems(
      [{ description: 'Ball valve.' }],
      CATALOG,
    );
    expect(unresolved).toHaveLength(0);
    expect(resolved[0]).toMatchObject({ catalogItemId: 'c-valve-ball', unitPriceCents: 3200 });
  });

  it('resolves fuzzy containment when a single candidate matches', () => {
    const { resolved } = resolveSpokenLineItems([{ description: 'water heater' }], CATALOG);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      catalogItemId: 'c-wh-install',
      description: 'Water Heater Install',
      unitPriceCents: 85000,
    });
  });

  it('defaults invalid quantities to 1', () => {
    const { resolved } = resolveSpokenLineItems(
      [{ description: 'gasket', quantity: -2 }],
      CATALOG,
    );
    expect(resolved[0]?.quantity).toBe(1);
  });

  it('with an empty catalog, everything stays unresolved (free-text degradation)', () => {
    const { resolved, unresolved } = resolveSpokenLineItems(
      [{ description: 'service call' }],
      [],
    );
    expect(resolved).toHaveLength(0);
    expect(unresolved).toHaveLength(1);
  });

  it('normalizeForMatch lowercases, strips punctuation, and singularizes', () => {
    expect(normalizeForMatch('  Three  GASKETS!! ')).toBe('three gasket');
  });

  describe('buildCatalogPromptSection (P22-001)', () => {
    it('returns an empty string for an empty catalog', () => {
      expect(buildCatalogPromptSection([])).toBe('');
    });

    it('renders name | unit | integer-cents price rows', () => {
      const section = buildCatalogPromptSection([item('c-1', 'Gasket', 450)]);
      expect(section).toContain('- Gasket | each | 450 cents');
      expect(section).not.toContain('truncated');
    });

    it('caps a >150-item catalog at 150 alphabetical items and notes truncation, without crashing', () => {
      const big = Array.from({ length: 400 }, (_, i) =>
        item(`c-${i}`, `Item ${String(i).padStart(3, '0')}`, 100 + i),
      );
      const section = buildCatalogPromptSection(big);
      const rows = section.split('\n').filter((l) => l.startsWith('- '));
      expect(rows).toHaveLength(CATALOG_PROMPT_ITEM_CAP);
      expect(section).toContain(`showing ${CATALOG_PROMPT_ITEM_CAP} of 400 items`);
      // Alphabetical: first row is the lowest-sorted name.
      expect(rows[0]).toContain('Item 000');
      // Prompt-size sanity (addendum risk note): the section stays
      // bounded even for a large catalog.
      expect(section.length).toBeLessThan(15000);
    });
  });
});

// Review hardening (PR #525 senior review): degenerate-name and edge cases.
describe('catalog-resolution — degenerate and edge inputs', () => {
  const gasket = { id: 'c1', name: 'Gasket', unitPriceCents: 450 };
  const serviceCall = { id: 'c2', name: 'Plumbing Service Call', unitPriceCents: 12500 };

  it('a punctuation-only catalog name never matches anything', () => {
    const junk = { id: 'junk', name: '###', unitPriceCents: 1 };
    const { resolved, unresolved } = resolveSpokenLineItems(
      [{ description: 'gasket' }],
      [junk, gasket],
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].catalogItemId).toBe('c1');
    expect(unresolved).toHaveLength(0);
  });

  it('an emoji-only catalog name never matches and never causes false ambiguity', () => {
    const emoji = { id: 'emoji', name: '🔥🔥', unitPriceCents: 1 };
    const { resolved } = resolveSpokenLineItems(
      [{ description: 'plumbing service call' }],
      [emoji, serviceCall],
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].catalogItemId).toBe('c2');
  });

  it('punctuation-only spoken description goes to unresolved, not a match-everything query', () => {
    const { resolved, unresolved } = resolveSpokenLineItems(
      [{ description: '!!!' }],
      [gasket, serviceCall],
    );
    expect(resolved).toHaveLength(0);
    expect(unresolved).toHaveLength(1);
  });

  it('duplicate catalog names stay ambiguous (never guess between equal-priced dupes)', () => {
    const dupeA = { id: 'a', name: 'Gasket', unitPriceCents: 450 };
    const dupeB = { id: 'b', name: 'Gasket', unitPriceCents: 500 };
    const { resolved, unresolved } = resolveSpokenLineItems(
      [{ description: 'gasket' }],
      [dupeA, dupeB],
    );
    expect(resolved).toHaveLength(0);
    expect(unresolved).toHaveLength(1);
  });

  it('accented characters strip to ascii skeleton and still resolve deterministically', () => {
    // normalizeForMatch strips non a-z0-9: "Café Valve" -> "caf valve".
    const accented = { id: 'acc', name: 'Café Valve', unitPriceCents: 700 };
    const { resolved } = resolveSpokenLineItems([{ description: 'café valve' }], [accented]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].catalogItemId).toBe('acc');
  });

  it('whitespace-only spoken description is unresolved', () => {
    const { resolved, unresolved } = resolveSpokenLineItems(
      [{ description: '   ' }],
      [gasket],
    );
    expect(resolved).toHaveLength(0);
    expect(unresolved).toHaveLength(1);
  });

  it('short real names (cap, fan) still resolve — no over-aggressive min-length filter', () => {
    const fan = { id: 'fan', name: 'Fan', unitPriceCents: 9900 };
    const { resolved } = resolveSpokenLineItems([{ description: 'fan' }], [fan]);
    expect(resolved).toHaveLength(1);
  });
});
