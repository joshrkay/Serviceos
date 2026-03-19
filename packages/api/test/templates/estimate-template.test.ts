import {
  createTemplate,
  instantiateTemplate,
  findBestTemplate,
  InMemoryEstimateTemplateRepository,
  EstimateTemplate,
} from '../../src/templates/estimate-template';
import { ValidationError } from '../../src/shared/errors';

describe('P4-004 — Estimate Templates', () => {
  let repo: InMemoryEstimateTemplateRepository;

  const sampleInput = {
    tenantId: 'tenant-1',
    verticalType: 'hvac' as const,
    categoryId: 'hvac-repair-ac',
    name: 'Standard AC Repair',
    description: 'Typical AC repair with diagnostic and labor',
    lineItemTemplates: [
      {
        description: 'Diagnostic fee',
        category: 'labor' as const,
        defaultQuantity: 1,
        defaultUnitPriceCents: 8900,
        taxable: true,
        sortOrder: 1,
        isOptional: false,
      },
      {
        description: 'AC Repair Labor',
        category: 'labor' as const,
        defaultQuantity: 2,
        defaultUnitPriceCents: 12500,
        taxable: true,
        sortOrder: 2,
        isOptional: false,
      },
      {
        description: 'Optional: refrigerant top-up',
        category: 'material' as const,
        defaultQuantity: 1,
        defaultUnitPriceCents: 7500,
        taxable: true,
        sortOrder: 3,
        isOptional: true,
      },
    ],
    createdBy: 'user-1',
  };

  beforeEach(() => {
    repo = new InMemoryEstimateTemplateRepository();
  });

  it('happy path — creates template', async () => {
    const template = await createTemplate(sampleInput, repo);
    expect(template.id).toBeTruthy();
    expect(template.name).toBe('Standard AC Repair');
    expect(template.lineItemTemplates).toHaveLength(3);
    expect(template.isActive).toBe(true);
    expect(template.usageCount).toBe(0);
  });

  it('write path — rejects missing tenantId', async () => {
    await expect(createTemplate({ ...sampleInput, tenantId: '' }, repo)).rejects.toMatchObject({
      name: 'ValidationError',
      message: 'Invalid template input',
    });
  });

  it('write path — rejects missing name', async () => {
    await expect(createTemplate({ ...sampleInput, name: '' }, repo)).rejects.toMatchObject({
      name: 'ValidationError',
      message: 'Invalid template input',
    });
  });

  it('write path — rejects empty line items', async () => {
    await expect(createTemplate({ ...sampleInput, lineItemTemplates: [] }, repo)).rejects.toMatchObject({
      name: 'ValidationError',
      message: 'Invalid template input',
    });
  });

  it('write path — rejects invalid line item values', async () => {
    await expect(
      createTemplate({
        ...sampleInput,
        lineItemTemplates: [
          { description: '', category: 'labor', defaultQuantity: -1, defaultUnitPriceCents: 100, taxable: true, sortOrder: 1, isOptional: false },
        ],
      }, repo)
    ).rejects.toMatchObject({
      name: 'ValidationError',
      message: 'Invalid template input',
    });
  });

  it('instantiates template with non-optional items', async () => {
    const template = await createTemplate(sampleInput, repo);
    const { lineItems, totals } = instantiateTemplate(template);

    // Only non-optional items
    expect(lineItems).toHaveLength(2);
    expect(lineItems[0].description).toBe('Diagnostic fee');
    expect(lineItems[1].description).toBe('AC Repair Labor');

    // Totals calculated
    expect(totals.subtotalCents).toBe(8900 + 25000); // 8900 + (2 * 12500)
    expect(totals.totalCents).toBe(33900);
  });

  it('finds templates by category', async () => {
    await createTemplate(sampleInput, repo);
    const found = await repo.findByCategory('tenant-1', 'hvac-repair-ac');
    expect(found).toHaveLength(1);
  });

  it('finds templates by vertical', async () => {
    await createTemplate(sampleInput, repo);
    const found = await repo.findByVertical('tenant-1', 'hvac');
    expect(found).toHaveLength(1);
  });

  it('tenant isolation — cannot find other tenant templates', async () => {
    await createTemplate(sampleInput, repo);
    const found = await repo.findByTenant('other-tenant');
    expect(found).toHaveLength(0);
  });

  it('finds best matching template by keywords', async () => {
    const t1 = await createTemplate(sampleInput, repo);
    const t2 = await createTemplate(
      { ...sampleInput, name: 'Emergency AC Repair', description: 'Emergency repair service' },
      repo
    );

    const templates = await repo.findByTenant('tenant-1');
    const best = findBestTemplate(templates, 'hvac-repair-ac', ['emergency']);
    expect(best).not.toBeNull();
    expect(best!.name).toBe('Emergency AC Repair');
  });

  it('tracks template usage count', async () => {
    const template = await createTemplate(sampleInput, repo);
    await repo.incrementUsage('tenant-1', template.id);
    await repo.incrementUsage('tenant-1', template.id);

    const found = await repo.findById('tenant-1', template.id);
    expect(found!.usageCount).toBe(2);
  });

  it('updates template', async () => {
    const template = await createTemplate(sampleInput, repo);
    const updated = await repo.update('tenant-1', template.id, { name: 'Updated Name' });
    expect(updated!.name).toBe('Updated Name');
  });
});
