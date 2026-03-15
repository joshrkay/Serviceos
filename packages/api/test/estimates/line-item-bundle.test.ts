import {
  createLineItemBundle,
  incrementBundleFrequency,
  calculateBundleConfidence,
  validateBundleInput,
  InMemoryLineItemBundleRepository,
} from '../../src/estimates/line-item-bundle';

describe('P4-006A — Line-item bundle pattern model', () => {
  it('happy path — creates bundle with all fields', () => {
    const bundle = createLineItemBundle({
      tenantId: 'tenant-1',
      verticalSlug: 'hvac',
      categoryId: 'hvac-repair',
      name: 'AC Repair Bundle',
      description: 'Common AC repair items',
      items: [
        { description: 'Diagnostic fee', typicalQuantity: 1, typicalUnitPrice: 89, isRequired: true, sortOrder: 1 },
        { description: 'Capacitor', typicalQuantity: 1, typicalUnitPrice: 250, isRequired: false, sortOrder: 2 },
      ],
    });

    expect(bundle.id).toBeTruthy();
    expect(bundle.frequency).toBe(1);
    expect(bundle.confidence).toBe(0);
    expect(bundle.items).toHaveLength(2);
  });

  it('happy path — incrementBundleFrequency increases count', () => {
    const bundle = createLineItemBundle({
      tenantId: 'tenant-1',
      verticalSlug: 'hvac',
      name: 'Test',
      description: 'Test',
      items: [],
    });
    const updated = incrementBundleFrequency(bundle);
    expect(updated.frequency).toBe(2);
    expect(updated.lastSeenAt.getTime()).toBeGreaterThanOrEqual(bundle.lastSeenAt.getTime());
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateBundleInput({
      tenantId: '',
      verticalSlug: '',
      name: '',
      description: '',
      items: null as any,
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('verticalSlug is required');
    expect(errors).toContain('name is required');
    expect(errors).toContain('items must be an array');
  });

  it('mock provider test — calculateBundleConfidence returns ratio', () => {
    const bundle = createLineItemBundle({ tenantId: 't', verticalSlug: 'v', name: 'n', description: 'd', items: [] });
    (bundle as any).frequency = 5;
    expect(calculateBundleConfidence(bundle, 10)).toBe(0.5);
    expect(calculateBundleConfidence(bundle, 0)).toBe(0);
  });

  it('mock provider test — repository stores and retrieves', async () => {
    const repo = new InMemoryLineItemBundleRepository();
    const bundle = createLineItemBundle({ tenantId: 'tenant-1', verticalSlug: 'hvac', name: 'Test', description: 'd', items: [] });
    await repo.create(bundle);

    const found = await repo.findById('tenant-1', bundle.id);
    expect(found).not.toBeNull();
  });

  it('mock provider test — repository isolates tenants', async () => {
    const repo = new InMemoryLineItemBundleRepository();
    const bundle = createLineItemBundle({ tenantId: 'tenant-1', verticalSlug: 'hvac', name: 'Test', description: 'd', items: [] });
    await repo.create(bundle);

    const found = await repo.findById('other-tenant', bundle.id);
    expect(found).toBeNull();
  });

  it('malformed AI output handled gracefully — empty items array', () => {
    const bundle = createLineItemBundle({ tenantId: 't', verticalSlug: 'v', name: 'n', description: 'd', items: [] });
    expect(bundle.items).toEqual([]);
  });
});
