import {
  InMemoryEstimateTemplateRepository,
  draftEstimateTemplateProposal,
  validateTemplateInput,
  CreateTemplateInput,
} from '../../src/ai/tasks/estimate-template';
import { calculateLineItemTotal } from '../../src/shared/billing-engine';
import { ValidationError } from '../../src/shared/errors';
import { validateProposalPayload } from '../../src/proposals/contracts';

const DRAFT_CTX = { tenantId: 'tenant-1', createdBy: 'user-1' };

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

  it('#1066 — drafts an onboarding_estimate_template PROPOSAL instead of writing the template', async () => {
    const proposal = draftEstimateTemplateProposal(validInput, DRAFT_CTX);

    expect(proposal.proposalType).toBe('onboarding_estimate_template');
    expect(proposal.tenantId).toBe('tenant-1');
    // Never auto-executed: a template is priced, so it waits for a human.
    expect(proposal.status).toBe('draft');
    expect(proposal.payload).toEqual({
      verticalType: 'hvac',
      categoryId: 'diagnostic',
      templateName: 'HVAC Diagnostic Template',
      lineItems: [
        { description: 'Diagnostic service call', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: 8900, taxable: true, sortOrder: 1 },
        { description: 'System inspection', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: 0, taxable: false, sortOrder: 2 },
      ],
      defaultNotes: 'Standard HVAC diagnostic visit',
    });
    expect(proposal.sourceContext).toMatchObject({ packId: 'hvac-v1' });
    // The payload is what the deterministic handler executes after approval,
    // so it must pass that proposal type's own contract.
    expect(validateProposalPayload('onboarding_estimate_template', proposal.payload)).toEqual({ valid: true });

    // …and NOTHING was written: the AI module no longer touches the store.
    expect(await repo.list()).toEqual([]);
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

  it('runtime validation — draftEstimateTemplateProposal rejects malformed input with typed error', () => {
    const invalidInput = { ...validInput, packId: '', defaultLineItems: [] };

    expect(() => draftEstimateTemplateProposal(invalidInput, DRAFT_CTX)).toThrow(ValidationError);
    expect(() => draftEstimateTemplateProposal(invalidInput, DRAFT_CTX)).toThrow(
      'Validation failed: packId is required, At least one default line item is required'
    );

    try {
      draftEstimateTemplateProposal(invalidInput, DRAFT_CTX);
      throw new Error('Expected draftEstimateTemplateProposal to throw ValidationError');
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
    const template = await repo.create({ ...validInput, id: 'tpl-1', sortOrder: 0, createdAt: new Date() });
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
