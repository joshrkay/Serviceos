import { PLUMBING_CATEGORIES, validatePlumbingCategoryTaxonomy } from '../../src/verticals/plumbing/categories';

describe('P4-003B — Plumbing service category taxonomy', () => {
  it('happy path — defines all required categories', () => {
    const categoryIds = PLUMBING_CATEGORIES.map((c) => c.id);
    expect(categoryIds).toContain('diagnostic');
    expect(categoryIds).toContain('repair');
    expect(categoryIds).toContain('install');
    expect(categoryIds).toContain('replacement');
    expect(categoryIds).toContain('drain');
    expect(categoryIds).toContain('water-heater');
    expect(categoryIds).toContain('emergency');
  });

  it('happy path — each category has required fields', () => {
    for (const cat of PLUMBING_CATEGORIES) {
      expect(cat.id).toBeTruthy();
      expect(cat.name).toBeTruthy();
      expect(cat.description).toBeTruthy();
      expect(cat.sortOrder).toBeGreaterThan(0);
      expect(Array.isArray(cat.typicalLineItems)).toBe(true);
      expect(cat.typicalLineItems.length).toBeGreaterThan(0);
    }
  });

  it('happy path — categories are sorted by sortOrder', () => {
    const sortOrders = PLUMBING_CATEGORIES.map((c) => c.sortOrder);
    const sorted = [...sortOrders].sort((a, b) => a - b);
    expect(sortOrders).toEqual(sorted);
  });

  it('happy path — validates the plumbing category taxonomy', () => {
    const errors = validatePlumbingCategoryTaxonomy(PLUMBING_CATEGORIES);
    expect(errors).toHaveLength(0);
  });

  it('validation — rejects empty taxonomy', () => {
    const errors = validatePlumbingCategoryTaxonomy([]);
    expect(errors).toContain('Category taxonomy must have at least one entry');
  });

  it('validation — rejects duplicate ids', () => {
    const errors = validatePlumbingCategoryTaxonomy([
      { id: 'diagnostic', name: 'A', description: 'A', sortOrder: 1, typicalLineItems: ['x'] },
      { id: 'diagnostic', name: 'B', description: 'B', sortOrder: 2, typicalLineItems: ['y'] },
    ] as any);
    expect(errors).toContain('Duplicate category id: diagnostic');
  });

  it('edge case — drain and water-heater are distinct categories', () => {
    const drain = PLUMBING_CATEGORIES.find((c) => c.id === 'drain');
    const waterHeater = PLUMBING_CATEGORIES.find((c) => c.id === 'water-heater');
    expect(drain).toBeDefined();
    expect(waterHeater).toBeDefined();
    expect(drain!.name).not.toBe(waterHeater!.name);
  });
});
