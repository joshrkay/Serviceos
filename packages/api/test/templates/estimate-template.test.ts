import {
  createTemplate,
  instantiateTemplate,
  findBestTemplate,
  validateTemplateInput,
  InMemoryEstimateTemplateRepository,
  EstimateTemplate,
} from '../../src/templates/estimate-template';

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

  it('validates required fields', () => {
    expect(validateTemplateInput({ ...sampleInput, tenantId: '' })).toContain('tenantId is required');
    expect(validateTemplateInput({ ...sampleInput, name: '' })).toContain('name is required');
    expect(validateTemplateInput({ ...sampleInput, lineItemTemplates: [] })).toContain(
      'at least one line item template is required'
    );
  });

  it('validates line item template values', () => {
    const errors = validateTemplateInput({
      ...sampleInput,
      lineItemTemplates: [
        { description: '', category: 'labor', defaultQuantity: -1, defaultUnitPriceCents: 100, taxable: true, sortOrder: 1, isOptional: false },
      ],
    });
    expect(errors).toContain('lineItemTemplates[0].description is required');
    expect(errors).toContain('lineItemTemplates[0].defaultQuantity must be non-negative');
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

import { buildTemplateInputFromEstimate } from '../../src/templates/estimate-template';
import { buildLineItem } from '../../src/shared/billing-engine';

describe('7.9 — buildTemplateInputFromEstimate', () => {
  const estimate = {
    lineItems: [
      buildLineItem('a', 'Diagnostic', 1, 8900, 0, true, 'labor'),
      { ...buildLineItem('b', 'Refrigerant', 2, 7500, 1, true, 'material'), isOptional: true },
      buildLineItem('c', 'Misc', 1, 1000, 2, false), // no category → 'other'
    ],
    totals: { discountCents: 500, taxRateBps: 825 },
    customerMessage: 'Thanks for your business',
  };

  it('maps line items, discount, tax, and message into a CreateTemplateInput', () => {
    const input = buildTemplateInputFromEstimate(estimate, {
      tenantId: 'tenant-1',
      name: 'AC Repair',
      verticalType: 'hvac',
      categoryId: 'hvac-repair-ac',
      description: 'Common AC repair',
      createdBy: 'user-1',
    });

    expect(input.tenantId).toBe('tenant-1');
    expect(input.name).toBe('AC Repair');
    expect(input.verticalType).toBe('hvac');
    expect(input.categoryId).toBe('hvac-repair-ac');
    expect(input.defaultDiscountCents).toBe(500);
    expect(input.defaultTaxRateBps).toBe(825);
    expect(input.defaultCustomerMessage).toBe('Thanks for your business');
    expect(input.lineItemTemplates).toHaveLength(3);
    expect(input.lineItemTemplates[0]).toMatchObject({
      description: 'Diagnostic',
      category: 'labor',
      defaultQuantity: 1,
      defaultUnitPriceCents: 8900,
      taxable: true,
      sortOrder: 0,
      isOptional: false,
    });
    expect(input.lineItemTemplates[1].isOptional).toBe(true);
    // A line with no category defaults to 'other'.
    expect(input.lineItemTemplates[2].category).toBe('other');
  });

  it('produces input that passes createTemplate validation and round-trips', async () => {
    const repo = new InMemoryEstimateTemplateRepository();
    const input = buildTemplateInputFromEstimate(estimate, {
      tenantId: 'tenant-1',
      name: 'AC Repair',
      verticalType: 'hvac',
      categoryId: 'hvac-repair-ac',
      createdBy: 'user-1',
    });
    const template = await createTemplate(input, repo);
    expect(template.id).toBeTruthy();
    const seeded = instantiateTemplate(template);
    // Optional lines are excluded when seeding a new estimate.
    expect(seeded.lineItems).toHaveLength(2);
  });
});
