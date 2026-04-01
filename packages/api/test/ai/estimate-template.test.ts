import {
  InMemoryEstimateTemplateRepository,
  createTemplate,
  findTemplate,
  validateTemplateInput,
  CreateTemplateInput,
} from '../../src/ai/tasks/estimate-template';
import { calculateLineItemTotal } from '../../src/shared/billing-engine';
import { ValidationError } from '../../src/shared/errors';

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

  it('validation — write path rejects missing packId with structured errors', async () => {
    await expect(createTemplate({ ...validInput, packId: '' }, repo)).rejects.toMatchObject({
      name: 'ValidationError',
      message: 'Invalid estimate template input',
      details: { errors: ['packId is required'] },
    } satisfies Partial<ValidationError>);
  });

  it('runtime validation — createTemplate rejects malformed payloads with typed error', async () => {
    const invalidInput = { ...validInput, packId: '', defaultLineItems: [] };

    await expect(createTemplate(invalidInput, repo)).rejects.toThrow(ValidationError);
    await expect(createTemplate(invalidInput, repo)).rejects.toThrow(
      'Validation failed: packId is required, At least one default line item is required'
    );

    try {
      await createTemplate(invalidInput, repo);
      throw new Error('Expected createTemplate to throw ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toEqual({
        errors: ['packId is required', 'At least one default line item is required'],
      });
    }
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

  it('deep-clones line items — mutations do not affect stored templates', async () => {
    const template = await createTemplate(validInput, repo);
    const retrieved = await repo.findById(template.id);
    expect(retrieved).not.toBeNull();

    // Mutate the returned line item
    retrieved!.defaultLineItems[0].description = 'MUTATED';

    // Re-fetch and verify the stored template is unaffected
    const fresh = await repo.findById(template.id);
    expect(fresh!.defaultLineItems[0].description).toBe('Diagnostic service call');
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
