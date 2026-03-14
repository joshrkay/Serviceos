import {
  recordInvoiceApproval,
  recordInvoiceRejection,
  validateInvoiceApprovalInput,
  validateInvoiceRejectionInput,
  InMemoryInvoiceApprovalRepository,
  RecordInvoiceApprovalInput,
  RecordInvoiceRejectionInput,
  InvoiceApprovalStatus,
} from '../../../src/ai/evaluation/invoice-approval';

describe('P5-009 — Invoice approval outcomes', () => {
  let repo: InMemoryInvoiceApprovalRepository;

  const tenantId = 'tenant-1';

  beforeEach(() => {
    repo = new InMemoryInvoiceApprovalRepository();
  });

  it('happy path — record approval', async () => {
    const result = await recordInvoiceApproval(
      {
        tenantId,
        invoiceId: 'inv-1',
        proposalId: 'prop-1',
        approvedBy: 'user-1',
      },
      repo
    );

    expect(result.id).toBeTruthy();
    expect(result.tenantId).toBe(tenantId);
    expect(result.invoiceId).toBe('inv-1');
    expect(result.proposalId).toBe('prop-1');
    expect(result.status).toBe('approved');
    expect(result.approvedBy).toBe('user-1');
    expect(result.approvedAt).toBeInstanceOf(Date);
    expect(result.approvedWithEdits).toBe(false);
  });

  it('happy path — record rejection', async () => {
    const result = await recordInvoiceRejection(
      {
        tenantId,
        invoiceId: 'inv-1',
        proposalId: 'prop-1',
        rejectedBy: 'user-1',
        rejectionReason: 'Incorrect line items',
      },
      repo
    );

    expect(result.id).toBeTruthy();
    expect(result.status).toBe('rejected');
    expect(result.rejectedBy).toBe('user-1');
    expect(result.rejectedAt).toBeInstanceOf(Date);
    expect(result.rejectionReason).toBe('Incorrect line items');
    expect(result.approvedWithEdits).toBe(false);
  });

  it('approved_with_edits flag works', async () => {
    const result = await recordInvoiceApproval(
      {
        tenantId,
        invoiceId: 'inv-1',
        proposalId: 'prop-1',
        approvedBy: 'user-1',
        approvedWithEdits: true,
        finalRevisionId: 'rev-2',
      },
      repo
    );

    expect(result.status).toBe('approved_with_edits');
    expect(result.approvedWithEdits).toBe(true);
    expect(result.finalRevisionId).toBe('rev-2');
  });

  it('double decision prevented', async () => {
    await recordInvoiceApproval(
      {
        tenantId,
        invoiceId: 'inv-1',
        proposalId: 'prop-1',
        approvedBy: 'user-1',
      },
      repo
    );

    await expect(
      recordInvoiceRejection(
        {
          tenantId,
          invoiceId: 'inv-1',
          proposalId: 'prop-2',
          rejectedBy: 'user-2',
        },
        repo
      )
    ).rejects.toThrow('Approval or rejection already recorded for this invoice');
  });

  it('validation — approval required fields', () => {
    const errors = validateInvoiceApprovalInput({
      tenantId: '',
      invoiceId: '',
      proposalId: '',
      approvedBy: '',
    });

    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('invoiceId is required');
    expect(errors).toContain('proposalId is required');
    expect(errors).toContain('approvedBy is required');
  });

  it('validation — rejection required fields', () => {
    const errors = validateInvoiceRejectionInput({
      tenantId: '',
      invoiceId: '',
      proposalId: '',
      rejectedBy: '',
    });

    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('invoiceId is required');
    expect(errors).toContain('proposalId is required');
    expect(errors).toContain('rejectedBy is required');
  });

  it('tenant isolation — cross-tenant lookup returns null', async () => {
    await recordInvoiceApproval(
      {
        tenantId,
        invoiceId: 'inv-1',
        proposalId: 'prop-1',
        approvedBy: 'user-1',
      },
      repo
    );

    const found = await repo.findByInvoice('tenant-2', 'inv-1');
    expect(found).toBeNull();
  });

  it('tenant isolation — findByTenant filters correctly', async () => {
    await recordInvoiceApproval(
      {
        tenantId: 'tenant-1',
        invoiceId: 'inv-1',
        proposalId: 'prop-1',
        approvedBy: 'user-1',
      },
      repo
    );

    await recordInvoiceApproval(
      {
        tenantId: 'tenant-2',
        invoiceId: 'inv-2',
        proposalId: 'prop-2',
        approvedBy: 'user-2',
      },
      repo
    );

    const t1Records = await repo.findByTenant('tenant-1');
    expect(t1Records).toHaveLength(1);
    expect(t1Records[0].invoiceId).toBe('inv-1');
  });
});
