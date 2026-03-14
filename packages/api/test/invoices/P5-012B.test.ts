import {
  recordInvoiceProposalOutcome,
  InMemoryInvoiceProposalOutcomeRepository,
} from '../../src/invoices/analytics';

describe('P5-012B — Invoice proposal outcome records', () => {
  let repo: InMemoryInvoiceProposalOutcomeRepository;

  beforeEach(() => {
    repo = new InMemoryInvoiceProposalOutcomeRepository();
  });

  it('creates record with all fields', async () => {
    const record = await recordInvoiceProposalOutcome(
      't1', 'prop-1', 'inv-1', 'approved', ['unitPriceCents', 'quantity'], 0.95, repo
    );
    expect(record.id).toBeTruthy();
    expect(record.tenantId).toBe('t1');
    expect(record.proposalId).toBe('prop-1');
    expect(record.invoiceId).toBe('inv-1');
    expect(record.outcome).toBe('approved');
    expect(record.editedFields).toEqual(['unitPriceCents', 'quantity']);
    expect(record.confidenceScore).toBe(0.95);
    expect(record.createdAt).toBeInstanceOf(Date);
  });

  it('repository stores and retrieves by tenant', async () => {
    await recordInvoiceProposalOutcome('t1', 'p1', 'inv-1', 'approved', [], undefined, repo);
    await recordInvoiceProposalOutcome('t1', 'p2', 'inv-2', 'rejected', ['description'], 0.7, repo);

    const records = await repo.findByTenant('t1');
    expect(records.length).toBe(2);
  });

  it('enforces tenant isolation', async () => {
    await recordInvoiceProposalOutcome('t1', 'p1', 'inv-1', 'approved', [], undefined, repo);
    await recordInvoiceProposalOutcome('t2', 'p2', 'inv-2', 'rejected', [], undefined, repo);

    const t1Records = await repo.findByTenant('t1');
    const t2Records = await repo.findByTenant('t2');
    expect(t1Records.length).toBe(1);
    expect(t2Records.length).toBe(1);
    expect(t1Records[0].tenantId).toBe('t1');
    expect(t2Records[0].tenantId).toBe('t2');
  });

  it('confidence score is optional', async () => {
    const record = await recordInvoiceProposalOutcome(
      't1', 'p1', 'inv-1', 'approved', [], undefined, repo
    );
    expect(record.confidenceScore).toBeUndefined();
  });
});
