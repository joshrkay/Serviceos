import {
  createEstimateTemplate,
  validateEstimateTemplateInput,
  InMemoryEstimateTemplateRepository,
} from '../../../src/ai/tasks/estimate-template';

describe('P4-004A — Vertical estimate template schema', () => {
  it('happy path — creates template with all fields', () => {
    const template = createEstimateTemplate({
      tenantId: 'tenant-1',
      verticalSlug: 'hvac',
      categoryId: 'hvac-repair',
      name: 'AC Repair Template',
      description: 'Standard AC repair estimate template',
      lineItemTemplates: [
        { description: 'Diagnostic fee', defaultQuantity: 1, defaultUnitPrice: 89, isOptional: false, sortOrder: 1 },
        { description: 'Capacitor replacement', defaultQuantity: 1, defaultUnitPrice: 250, isOptional: true, sortOrder: 2, category: 'parts' },
      ],
      promptHints: ['Include diagnostic fee', 'Check for capacitor issues'],
    });

    expect(template.id).toBeTruthy();
    expect(template.version).toBe(1);
    expect(template.isActive).toBe(true);
    expect(template.lineItemTemplates).toHaveLength(2);
    expect(template.promptHints).toHaveLength(2);
  });

  it('happy path — global template has null tenantId', () => {
    const template = createEstimateTemplate({
      verticalSlug: 'hvac',
      categoryId: 'hvac-maintenance',
      name: 'Global Maintenance',
      description: 'Global template',
      lineItemTemplates: [],
    });

    expect(template.tenantId).toBeNull();
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateEstimateTemplateInput({
      verticalSlug: '',
      categoryId: '',
      name: '',
      description: '',
      lineItemTemplates: null as any,
    });
    expect(errors).toContain('verticalSlug is required');
    expect(errors).toContain('categoryId is required');
    expect(errors).toContain('name is required');
    expect(errors).toContain('description is required');
    expect(errors).toContain('lineItemTemplates must be an array');
  });

  it('mock provider test — repository stores and retrieves', async () => {
    const repo = new InMemoryEstimateTemplateRepository();
    const template = createEstimateTemplate({
      verticalSlug: 'hvac',
      categoryId: 'hvac-repair',
      name: 'Test',
      description: 'Test',
      lineItemTemplates: [],
    });
    await repo.create(template);

    const found = await repo.findById(template.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Test');
  });

  it('mock provider test — findByVerticalAndCategory filters correctly', async () => {
    const repo = new InMemoryEstimateTemplateRepository();
    const t1 = createEstimateTemplate({ verticalSlug: 'hvac', categoryId: 'hvac-repair', name: 'T1', description: 'd', lineItemTemplates: [] });
    const t2 = createEstimateTemplate({ verticalSlug: 'hvac', categoryId: 'hvac-install', name: 'T2', description: 'd', lineItemTemplates: [] });
    const t3 = createEstimateTemplate({ verticalSlug: 'plumbing', categoryId: 'plumb-repair', name: 'T3', description: 'd', lineItemTemplates: [] });
    await repo.create(t1);
    await repo.create(t2);
    await repo.create(t3);

    const results = await repo.findByVerticalAndCategory('hvac', 'hvac-repair');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('T1');
  });

  it('malformed AI output handled gracefully — defaults promptHints to empty', () => {
    const template = createEstimateTemplate({
      verticalSlug: 'hvac',
      categoryId: 'hvac-repair',
      name: 'Test',
      description: 'Test',
      lineItemTemplates: [],
    });
    expect(template.promptHints).toEqual([]);
  });
});
