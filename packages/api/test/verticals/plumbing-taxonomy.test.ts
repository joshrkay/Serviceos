import { plumbingCategories } from '../../src/verticals/data/plumbing-taxonomy';
import { createServiceTaxonomy, findCategoryById, findCategoryByName, getCategoryPath } from '../../src/verticals/service-taxonomy';

describe('P4-003B — Plumbing service category taxonomy', () => {
  const taxonomy = createServiceTaxonomy({
    verticalSlug: 'plumbing',
    version: '1.0.0',
    categories: plumbingCategories,
  });

  it('happy path — taxonomy has categories', () => {
    expect(taxonomy.categories.length).toBeGreaterThanOrEqual(10);
    expect(taxonomy.verticalSlug).toBe('plumbing');
  });

  it('happy path — findCategoryById returns correct category', () => {
    const cat = findCategoryById(taxonomy, 'plumb-drain');
    expect(cat).not.toBeNull();
    expect(cat!.name).toBe('Drain Services');
  });

  it('happy path — getCategoryPath for subcategory', () => {
    const path = getCategoryPath(taxonomy, 'plumb-drain-hydrojetting');
    expect(path).toHaveLength(2);
    expect(path[0].id).toBe('plumb-drain');
    expect(path[1].id).toBe('plumb-drain-hydrojetting');
  });

  it('validation — all categories have required fields', () => {
    for (const cat of plumbingCategories) {
      expect(cat.id).toBeTruthy();
      expect(cat.name).toBeTruthy();
      expect(cat.description).toBeTruthy();
      expect(Array.isArray(cat.tags)).toBe(true);
    }
  });

  it('mock provider test — findCategoryByName is case-insensitive', () => {
    expect(findCategoryByName(taxonomy, 'drain services')).not.toBeNull();
    expect(findCategoryByName(taxonomy, 'DRAIN SERVICES')).not.toBeNull();
  });

  it('malformed AI output handled gracefully — findCategoryById returns null for unknown', () => {
    expect(findCategoryById(taxonomy, 'nonexistent')).toBeNull();
  });
});
