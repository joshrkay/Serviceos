import {
  InMemoryApprovedEstimateMetadataRepository,
  createApprovedEstimateMetadata,
  validateApprovedEstimateMetadataInput,
} from '../../src/estimates/approved-estimate-metadata';
import { ValidationError } from '../../src/shared/errors';

describe('P4-005A — Approved-estimate retrieval metadata', () => {
  let repo: InMemoryApprovedEstimateMetadataRepository;

  beforeEach(() => {
    repo = new InMemoryApprovedEstimateMetadataRepository();
  });

  it('happy path — creates and retrieves metadata', async () => {
    const metadata = await createApprovedEstimateMetadata({
      tenantId: 't1',
      estimateId: 'est-1',
      verticalType: 'hvac',
      serviceCategory: 'diagnostic',
      approvalOutcome: 'approved',
      approvedAt: new Date(),
      lineItemCount: 3,
      totalCents: 25000,
      lineItemSummary: ['Diagnostic fee', 'Inspection', 'Report'],
      tags: ['routine'],
    }, repo);

    expect(metadata.id).toBeDefined();
    expect(metadata.tenantId).toBe('t1');
    expect(metadata.verticalType).toBe('hvac');
    expect(metadata.lineItemSummary).toHaveLength(3);

    const found = await repo.findByEstimate('t1', 'est-1');
    expect(found).not.toBeNull();
  });

  it('happy path — finds by tenant', async () => {
    await createApprovedEstimateMetadata({
      tenantId: 't1', estimateId: 'est-1', approvalOutcome: 'approved',
      approvedAt: new Date(), lineItemCount: 1, totalCents: 1000, lineItemSummary: ['Item'],
    }, repo);
    await createApprovedEstimateMetadata({
      tenantId: 't1', estimateId: 'est-2', approvalOutcome: 'approved_with_edits',
      approvedAt: new Date(), lineItemCount: 2, totalCents: 2000, lineItemSummary: ['A', 'B'],
    }, repo);

    const results = await repo.findByTenant('t1');
    expect(results).toHaveLength(2);
  });

  it('validation — rejects missing tenantId', () => {
    const errors = validateApprovedEstimateMetadataInput({
      tenantId: '', estimateId: 'est-1', approvalOutcome: 'approved',
      approvedAt: new Date(), lineItemCount: 1, totalCents: 100, lineItemSummary: [],
    });
    expect(errors).toContain('tenantId is required');
  });

  it('validation — rejects negative lineItemCount', () => {
    const errors = validateApprovedEstimateMetadataInput({
      tenantId: 't1', estimateId: 'est-1', approvalOutcome: 'approved',
      approvedAt: new Date(), lineItemCount: -1, totalCents: 100, lineItemSummary: [],
    });
    expect(errors).toContain('lineItemCount must be non-negative');
  });

  it('runtime validation — createApprovedEstimateMetadata rejects malformed payloads with deterministic text', async () => {
    const invalidInput = {
      tenantId: '',
      estimateId: '',
      approvalOutcome: 'approved' as const,
      approvedAt: new Date(),
      lineItemCount: -1,
      totalCents: -5,
      lineItemSummary: [],
    };

    await expect(createApprovedEstimateMetadata(invalidInput, repo)).rejects.toThrow(ValidationError);
    await expect(createApprovedEstimateMetadata(invalidInput, repo)).rejects.toThrow(
      'Validation failed: tenantId is required, estimateId is required, lineItemCount must be non-negative, totalCents must be non-negative'
    );

    try {
      await createApprovedEstimateMetadata(invalidInput, repo);
      throw new Error('Expected createApprovedEstimateMetadata to throw ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toEqual({
        errors: [
          'tenantId is required',
          'estimateId is required',
          'lineItemCount must be non-negative',
          'totalCents must be non-negative',
        ],
      });
    }
  });

  it('tenant isolation — only returns own tenant records', async () => {
    await createApprovedEstimateMetadata({
      tenantId: 't1', estimateId: 'est-1', approvalOutcome: 'approved',
      approvedAt: new Date(), lineItemCount: 1, totalCents: 100, lineItemSummary: ['X'],
    }, repo);
    await createApprovedEstimateMetadata({
      tenantId: 't2', estimateId: 'est-2', approvalOutcome: 'approved',
      approvedAt: new Date(), lineItemCount: 1, totalCents: 200, lineItemSummary: ['Y'],
    }, repo);

    const t1 = await repo.findByTenant('t1');
    expect(t1).toHaveLength(1);
    expect(t1[0].estimateId).toBe('est-1');
  });
});
