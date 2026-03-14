import {
  createBundle,
  matchBundles,
  validateBundleInput,
  InMemoryServiceBundleRepository,
  ServiceBundle,
} from '../../src/verticals/bundles';

describe('P4-006 — Bundle Patterns', () => {
  let repo: InMemoryServiceBundleRepository;

  const sampleInput = {
    tenantId: 'tenant-1',
    verticalType: 'hvac' as const,
    name: 'AC Tune-Up Bundle',
    description: 'Seasonal AC tune-up with filter replacement',
    categoryIds: ['hvac-maint-tuneup', 'hvac-maint-filter'],
    lineItemTemplates: [
      {
        description: 'AC Seasonal Tune-Up',
        category: 'labor' as const,
        defaultQuantity: 1,
        defaultUnitPriceCents: 9900,
        taxable: true,
        sortOrder: 1,
        isOptional: false,
      },
      {
        description: 'Filter Replacement',
        category: 'material' as const,
        defaultQuantity: 1,
        defaultUnitPriceCents: 2500,
        taxable: true,
        sortOrder: 2,
        isOptional: false,
      },
    ],
    triggerKeywords: ['tune up', 'tune-up', 'seasonal maintenance', 'ac checkup'],
  };

  beforeEach(() => {
    repo = new InMemoryServiceBundleRepository();
  });

  it('happy path — creates bundle', async () => {
    const bundle = await createBundle(sampleInput, repo);
    expect(bundle.id).toBeTruthy();
    expect(bundle.name).toBe('AC Tune-Up Bundle');
    expect(bundle.triggerKeywords).toContain('tune up');
    expect(bundle.isActive).toBe(true);
  });

  it('validates required fields', () => {
    expect(validateBundleInput({ ...sampleInput, tenantId: '' })).toContain('tenantId is required');
    expect(validateBundleInput({ ...sampleInput, categoryIds: [] })).toContain(
      'at least one categoryId is required'
    );
    expect(validateBundleInput({ ...sampleInput, triggerKeywords: [] })).toContain(
      'at least one trigger keyword is required'
    );
  });

  it('normalizes trigger keywords to lowercase', async () => {
    const bundle = await createBundle(
      { ...sampleInput, triggerKeywords: ['AC Tune-Up', 'HVAC Check'] },
      repo
    );
    expect(bundle.triggerKeywords).toContain('ac tune-up');
    expect(bundle.triggerKeywords).toContain('hvac check');
  });

  it('matches bundles by keyword in text', async () => {
    const bundle = await createBundle(sampleInput, repo);
    const allBundles = await repo.findByTenant('tenant-1');

    const matched = matchBundles(allBundles, 'I need a tune up for my AC');
    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe('AC Tune-Up Bundle');
  });

  it('scores multi-word keywords higher', async () => {
    await createBundle(sampleInput, repo);
    await createBundle(
      {
        ...sampleInput,
        name: 'Full Service Bundle',
        triggerKeywords: ['seasonal maintenance and filter', 'full service'],
      },
      repo
    );

    const allBundles = await repo.findByTenant('tenant-1');
    const matched = matchBundles(allBundles, 'seasonal maintenance and filter replacement');
    expect(matched.length).toBeGreaterThanOrEqual(1);
    // Multi-word match should score higher
    expect(matched[0].name).toBe('Full Service Bundle');
  });

  it('returns empty when no keywords match', async () => {
    await createBundle(sampleInput, repo);
    const allBundles = await repo.findByTenant('tenant-1');
    const matched = matchBundles(allBundles, 'plumbing leak repair');
    expect(matched).toHaveLength(0);
  });

  it('tenant isolation — cannot access other tenant bundles', async () => {
    await createBundle(sampleInput, repo);
    const found = await repo.findByTenant('other-tenant');
    expect(found).toHaveLength(0);
  });

  it('finds bundles by vertical type', async () => {
    await createBundle(sampleInput, repo);
    const found = await repo.findByVertical('tenant-1', 'hvac');
    expect(found).toHaveLength(1);
  });

  it('tracks usage count', async () => {
    const bundle = await createBundle(sampleInput, repo);
    await repo.incrementUsage('tenant-1', bundle.id);
    const found = await repo.findById('tenant-1', bundle.id);
    expect(found!.usageCount).toBe(1);
  });
});
