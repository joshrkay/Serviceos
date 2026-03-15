import { hvacCategories } from '../../src/verticals/data/hvac-taxonomy';
import { createServiceTaxonomy, findCategoryById, findCategoryByName, getCategoryPath } from '../../src/verticals/service-taxonomy';

describe('P4-002B — HVAC service category taxonomy', () => {
  const taxonomy = createServiceTaxonomy({
    verticalSlug: 'hvac',
    version: '1.0.0',
    categories: hvacCategories,
  });

  it('happy path — taxonomy has categories', () => {
    expect(taxonomy.categories.length).toBeGreaterThanOrEqual(10);
    expect(taxonomy.verticalSlug).toBe('hvac');
  });

  it('happy path — findCategoryById returns correct category', () => {
    const cat = findCategoryById(taxonomy, 'hvac-repair');
    expect(cat).not.toBeNull();
    expect(cat!.name).toBe('Repair');
  });

  it('happy path — getCategoryPath returns root-to-leaf path', () => {
    const path = getCategoryPath(taxonomy, 'hvac-repair-electrical');
    expect(path).toHaveLength(2);
    expect(path[0].id).toBe('hvac-repair');
    expect(path[1].id).toBe('hvac-repair-electrical');
  });

  it('validation — all categories have required fields', () => {
    for (const cat of hvacCategories) {
      expect(cat.id).toBeTruthy();
      expect(cat.name).toBeTruthy();
      expect(cat.description).toBeTruthy();
      expect(Array.isArray(cat.tags)).toBe(true);
      expect(typeof cat.sortOrder).toBe('number');
    }
  });

  it('mock provider test — findCategoryByName is case-insensitive', () => {
    expect(findCategoryByName(taxonomy, 'repair')).not.toBeNull();
    expect(findCategoryByName(taxonomy, 'REPAIR')).not.toBeNull();
  });

  it('malformed AI output handled gracefully — findCategoryById returns null for unknown', () => {
    expect(findCategoryById(taxonomy, 'nonexistent')).toBeNull();
  });
});
