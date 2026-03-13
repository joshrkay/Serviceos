import {
  InMemoryEstimateTemplateRepository,
  createTemplate,
  findTemplate,
  validateTemplateInput,
  CreateTemplateInput,
} from '../../src/ai/tasks/estimate-template';
import { calculateLineItemTotal } from '../../src/shared/billing-engine';

describe('P4-004A — Vertical estimate template schema', () => {
  let repo: InMemoryEstimateTemplateRepository;

  beforeEach(() => {
    repo = new InMemoryEstimateTemplateRepository();
  });

  const validInput: CreateTemplateInput = {
    packId: 'hvac-v1',
    verticalType: 'hvac',
    serviceCategory: 'diagnostic',
    name: 'HVAC Diagnostic Template',
    defaultLineItems: [
      { description: 'Diagnostic service call', category: 'labor', quantity: 1, unitPriceCents: 8900, taxable: true, sortOrder: 1 },
      { description: 'System inspection', category: 'labor', quantity: 1, unitPriceCents: 0, taxable: false, sortOrder: 2 },
    ],
    defaultNotes: 'Standard HVAC diagnostic visit',
  };

  it('happy path — creates and retrieves a template', async () => {
    const template = await createTemplate(validInput, repo);

    expect(template.id).toBeDefined();
    expect(template.packId).toBe('hvac-v1');
    expect(template.verticalType).toBe('hvac');
    expect(template.serviceCategory).toBe('diagnostic');
    expect(template.defaultLineItems).toHaveLength(2);
    expect(template.defaultNotes).toBe('Standard HVAC diagnostic visit');

    const found = await repo.findById(template.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('HVAC Diagnostic Template');
  });

  it('happy path — template line items produce valid billing totals', () => {
    for (const item of validInput.defaultLineItems) {
      const total = calculateLineItemTotal(item.quantity, item.unitPriceCents);
      expect(total).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(total)).toBe(true);
    }
  });

  it('validation — rejects missing packId', () => {
    const errors = validateTemplateInput({ ...validInput, packId: '' });
    expect(errors).toContain('packId is required');
  });

  it('validation — rejects missing name', () => {
    const errors = validateTemplateInput({ ...validInput, name: '' });
    expect(errors).toContain('name is required');
  });

  it('validation — rejects empty line items', () => {
    const errors = validateTemplateInput({ ...validInput, defaultLineItems: [] });
    expect(errors).toContain('At least one default line item is required');
  });

  it('validation — rejects line item missing description', () => {
    const errors = validateTemplateInput({
      ...validInput,
      defaultLineItems: [{ description: '', category: 'labor', quantity: 1, unitPriceCents: 100, taxable: true, sortOrder: 1 }],
    });
    expect(errors).toContain('Line item 0 is missing description');
  });

  it('validation — rejects invalid line item category', () => {
    const errors = validateTemplateInput({
      ...validInput,
      defaultLineItems: [{ description: 'Test', category: 'invalid' as any, quantity: 1, unitPriceCents: 100, taxable: true, sortOrder: 1 }],
    });
    expect(errors).toContain('Line item 0 has invalid category');
  });

  it('mock provider — malformed input handled gracefully', () => {
    const errors = validateTemplateInput({
      packId: undefined as any,
      verticalType: undefined as any,
      serviceCategory: undefined as any,
      name: undefined as any,
      defaultLineItems: undefined as any,
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors).toContain('packId is required');
    expect(errors).toContain('verticalType is required');
    expect(errors).toContain('serviceCategory is required');
    expect(errors).toContain('name is required');
    expect(errors).toContain('At least one default line item is required');
  });
});
