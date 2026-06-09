import { describe, expect, it } from 'vitest';
import { catalogItemToDraft, mapCatalogCategory } from './catalogToLineItem';

describe('mapCatalogCategory', () => {
  it('maps catalog PascalCase categories to the line-item enum', () => {
    expect(mapCatalogCategory('Labor')).toBe('labor');
    expect(mapCatalogCategory('Parts')).toBe('material');
    expect(mapCatalogCategory('Materials')).toBe('material');
    expect(mapCatalogCategory('Equipment')).toBe('equipment');
  });

  it('is case-insensitive', () => {
    expect(mapCatalogCategory('labor')).toBe('labor');
    expect(mapCatalogCategory('MATERIALS')).toBe('material');
    expect(mapCatalogCategory('equipment')).toBe('equipment');
  });

  it('returns undefined for unknown or missing categories', () => {
    // undefined (not '') so the optional-enum line-item contract omits it.
    expect(mapCatalogCategory('Other')).toBeUndefined();
    expect(mapCatalogCategory('')).toBeUndefined();
    expect(mapCatalogCategory(undefined)).toBeUndefined();
  });
});

describe('catalogItemToDraft', () => {
  it('converts cents to a dollar string and defaults qty/taxable', () => {
    const draft = catalogItemToDraft({
      id: 'cat-1',
      name: 'AC tune-up',
      unitPriceCents: 12900,
      category: 'Labor',
    });
    expect(draft.unitPriceDollars).toBe('129.00');
    expect(draft.quantity).toBe('1');
    expect(draft.taxable).toBe(true);
    expect(draft.category).toBe('labor');
    expect(draft.description).toBe('AC tune-up');
    expect(draft.id).toMatch(/^li-/);
  });

  it('appends the unit to the description when present', () => {
    const draft = catalogItemToDraft({
      id: 'cat-2',
      name: 'Labor',
      unitPriceCents: 9500,
      unit: 'per hr',
      category: 'Labor',
    });
    expect(draft.description).toBe('Labor (per hr)');
  });

  it('generates a unique id per call', () => {
    const item = { id: 'cat-3', name: 'Filter', unitPriceCents: 950 };
    expect(catalogItemToDraft(item).id).not.toBe(catalogItemToDraft(item).id);
  });
});
