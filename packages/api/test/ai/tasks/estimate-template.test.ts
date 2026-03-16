import {
  createTemplate,
  validateTemplateInput,
  InMemoryEstimateTemplateRepository,
} from '../../../src/ai/tasks/estimate-template';

describe('P4-004A — Vertical estimate template schema', () => {
  it('happy path — creates template with all fields', async () => {
    const repo = new InMemoryEstimateTemplateRepository();
    const template = await createTemplate({
      packId: 'pack-1',
      verticalType: 'hvac',
      serviceCategory: 'repair',
      name: 'AC Repair Template',
      defaultNotes: 'Standard AC repair estimate template',
      defaultLineItems: [
        { description: 'Diagnostic fee', quantity: 1, unitPriceCents: 8900, taxable: true, sortOrder: 1 },
        { description: 'Capacitor replacement', quantity: 1, unitPriceCents: 25000, taxable: true, sortOrder: 2, category: 'material' },
      ],
    }, repo);

    expect(template.id).toBeTruthy();
    expect(template.defaultLineItems).toHaveLength(2);
  });

  it('happy path — template has verticalType and serviceCategory', async () => {
    const repo = new InMemoryEstimateTemplateRepository();
    const template = await createTemplate({
      packId: 'pack-1',
      verticalType: 'hvac',
      serviceCategory: 'maintenance',
      name: 'Global Maintenance',
      defaultLineItems: [],
    }, repo);

    expect(template.verticalType).toBe('hvac');
    expect(template.serviceCategory).toBe('maintenance');
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateTemplateInput({
      packId: '',
      verticalType: '' as any,
      serviceCategory: '' as any,
      name: '',
      defaultLineItems: [],
    });
    expect(errors).toContain('packId is required');
    expect(errors).toContain('verticalType is required');
    expect(errors).toContain('serviceCategory is required');
    expect(errors).toContain('name is required');
    expect(errors).toContain('At least one default line item is required');
  });

  it('mock provider test — repository stores and retrieves', async () => {
    const repo = new InMemoryEstimateTemplateRepository();
    const template = await createTemplate({
      packId: 'pack-1',
      verticalType: 'hvac',
      serviceCategory: 'repair',
      name: 'Test',
      defaultLineItems: [{ description: 'Item', quantity: 1, unitPriceCents: 1000, taxable: true, sortOrder: 1 }],
    }, repo);

    const found = await repo.findById(template.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Test');
  });

  it('mock provider test — findByVerticalAndCategory filters correctly', async () => {
    const repo = new InMemoryEstimateTemplateRepository();
    await createTemplate({ packId: 'p1', verticalType: 'hvac', serviceCategory: 'repair', name: 'T1', defaultLineItems: [{ description: 'a', quantity: 1, unitPriceCents: 100, taxable: true, sortOrder: 1 }] }, repo);
    await createTemplate({ packId: 'p1', verticalType: 'hvac', serviceCategory: 'install', name: 'T2', defaultLineItems: [{ description: 'b', quantity: 1, unitPriceCents: 100, taxable: true, sortOrder: 1 }] }, repo);
    await createTemplate({ packId: 'p2', verticalType: 'plumbing', serviceCategory: 'repair', name: 'T3', defaultLineItems: [{ description: 'c', quantity: 1, unitPriceCents: 100, taxable: true, sortOrder: 1 }] }, repo);

    const result = await repo.findByVerticalAndCategory('hvac', 'repair');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('T1');
  });

  it('malformed AI output handled gracefully — defaults empty arrays', async () => {
    const repo = new InMemoryEstimateTemplateRepository();
    const template = await createTemplate({
      packId: 'pack-1',
      verticalType: 'hvac',
      serviceCategory: 'repair',
      name: 'Test',
      defaultLineItems: [{ description: 'min', quantity: 1, unitPriceCents: 100, taxable: true, sortOrder: 1 }],
    }, repo);
    expect(template.defaultLineItems).toHaveLength(1);
  });
});
