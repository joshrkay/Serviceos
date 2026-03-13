import {
  recordApproval,
  recordRejection,
  validateApprovalInput,
  validateRejectionInput,
  InMemoryApprovalRepository,
} from '../../src/estimates/approval';

describe('P1-009E — Estimate approval outcomes', () => {
  let repo: InMemoryApprovalRepository;

  beforeEach(() => {
    repo = new InMemoryApprovalRepository();
  });

  it('happy path — records approval', async () => {
    const approval = await recordApproval(
      { tenantId: 'tenant-1', estimateId: 'est-1', approvedBy: 'user-1' },
      repo
    );

    expect(approval.id).toBeTruthy();
    expect(approval.status).toBe('approved');
    expect(approval.approvedBy).toBe('user-1');
    expect(approval.approvedAt).toBeTruthy();
    expect(approval.approvedWithEdits).toBe(false);
  });

  it('happy path — records approval with edits', async () => {
    const approval = await recordApproval(
      {
        tenantId: 'tenant-1',
        estimateId: 'est-1',
        approvedBy: 'user-1',
        approvedWithEdits: true,
        finalRevisionId: 'rev-3',
      },
      repo
    );

    expect(approval.status).toBe('approved_with_edits');
    expect(approval.approvedWithEdits).toBe(true);
    expect(approval.finalRevisionId).toBe('rev-3');
  });

  it('happy path — records rejection with reason', async () => {
    const rejection = await recordRejection(
      {
        tenantId: 'tenant-1',
        estimateId: 'est-1',
        rejectedBy: 'customer-1',
        rejectionReason: 'Price too high',
      },
      repo
    );

    expect(rejection.status).toBe('rejected');
    expect(rejection.rejectedBy).toBe('customer-1');
    expect(rejection.rejectionReason).toBe('Price too high');
    expect(rejection.rejectedAt).toBeTruthy();
  });

  it('happy path — retrieves approval by estimate', async () => {
    await recordApproval(
      { tenantId: 'tenant-1', estimateId: 'est-1', approvedBy: 'user-1' },
      repo
    );

    const found = await repo.findByEstimate('tenant-1', 'est-1');
    expect(found).not.toBeNull();
    expect(found!.estimateId).toBe('est-1');
  });

  it('validation — rejects missing approval fields', () => {
    const errors = validateApprovalInput({
      tenantId: '',
      estimateId: '',
      approvedBy: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('estimateId is required');
    expect(errors).toContain('approvedBy is required');
  });

  it('validation — rejects missing rejection fields', () => {
    const errors = validateRejectionInput({
      tenantId: '',
      estimateId: '',
      rejectedBy: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('estimateId is required');
    expect(errors).toContain('rejectedBy is required');
  });
});
