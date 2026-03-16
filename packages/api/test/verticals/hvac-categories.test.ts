import { HVAC_CATEGORIES, validateCategoryTaxonomy } from '../../src/verticals/hvac/categories';

describe('P4-002B — HVAC service category taxonomy', () => {
  it('happy path — defines all required categories', () => {
    const categoryIds = HVAC_CATEGORIES.map((c) => c.id);
    expect(categoryIds).toContain('diagnostic');
    expect(categoryIds).toContain('repair');
    expect(categoryIds).toContain('maintenance');
    expect(categoryIds).toContain('install');
    expect(categoryIds).toContain('replacement');
    expect(categoryIds).toContain('emergency');
  });

  it('happy path — each category has required fields', () => {
    for (const cat of HVAC_CATEGORIES) {
      expect(cat.id).toBeTruthy();
      expect(cat.name).toBeTruthy();
      expect(cat.description).toBeTruthy();
      expect(cat.sortOrder).toBeGreaterThan(0);
      expect(Array.isArray(cat.typicalLineItems)).toBe(true);
      expect(cat.typicalLineItems.length).toBeGreaterThan(0);
    }
  });

  it('happy path — categories are sorted by sortOrder', () => {
    const sortOrders = HVAC_CATEGORIES.map((c) => c.sortOrder);
    const sorted = [...sortOrders].sort((a, b) => a - b);
    expect(sortOrders).toEqual(sorted);
  });

  it('happy path — validates the HVAC category taxonomy', () => {
    const errors = validateCategoryTaxonomy(HVAC_CATEGORIES);
    expect(errors).toHaveLength(0);
  });

  it('validation — rejects empty taxonomy', () => {
    const errors = validateCategoryTaxonomy([]);
    expect(errors).toContain('Category taxonomy must have at least one entry');
  });

  it('validation — rejects duplicate ids', () => {
    const errors = validateCategoryTaxonomy([
      { id: 'diagnostic', name: 'A', description: 'A', sortOrder: 1, typicalLineItems: ['x'] },
      { id: 'diagnostic', name: 'B', description: 'B', sortOrder: 2, typicalLineItems: ['y'] },
    ] as any);
    expect(errors).toContain('Duplicate category id: diagnostic');
  });

  it('validation — rejects unknown parentId', () => {
    const errors = validateCategoryTaxonomy([
      { id: 'child', name: 'Child', description: 'Child', parentId: 'nonexistent', sortOrder: 1, typicalLineItems: ['x'] },
    ] as any);
    expect(errors).toContain('Category "child" references unknown parentId: nonexistent');
  });
});
