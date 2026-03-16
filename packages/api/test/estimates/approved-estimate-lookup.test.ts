import {
  InMemoryApprovedEstimateMetadataRepository,
  createApprovedEstimateMetadata,
  lookupApprovedEstimates,
} from '../../src/estimates/approved-estimate-metadata';

describe('P4-005B — Tenant-scoped approved-estimate lookup', () => {
  let repo: InMemoryApprovedEstimateMetadataRepository;

  beforeEach(async () => {
    repo = new InMemoryApprovedEstimateMetadataRepository();
    await createApprovedEstimateMetadata({
      tenantId: 't1', estimateId: 'est-1', verticalType: 'hvac', serviceCategory: 'diagnostic',
      approvalOutcome: 'approved', approvedAt: new Date('2024-01-15'),
      lineItemCount: 2, totalCents: 15000, lineItemSummary: ['Diagnostic fee', 'Inspection'],
    }, repo);
    await createApprovedEstimateMetadata({
      tenantId: 't1', estimateId: 'est-2', verticalType: 'hvac', serviceCategory: 'repair',
      approvalOutcome: 'approved_with_edits', approvedAt: new Date('2024-02-10'),
      lineItemCount: 3, totalCents: 35000, lineItemSummary: ['Repair labor', 'Parts', 'Disposal'],
    }, repo);
    await createApprovedEstimateMetadata({
      tenantId: 't1', estimateId: 'est-3', verticalType: 'plumbing', serviceCategory: 'drain',
      approvalOutcome: 'approved', approvedAt: new Date('2024-03-05'),
      lineItemCount: 1, totalCents: 12000, lineItemSummary: ['Drain cleaning'],
    }, repo);
    await createApprovedEstimateMetadata({
      tenantId: 't2', estimateId: 'est-4', verticalType: 'hvac', serviceCategory: 'diagnostic',
      approvalOutcome: 'approved', approvedAt: new Date('2024-01-20'),
      lineItemCount: 1, totalCents: 8000, lineItemSummary: ['Diagnostic'],
    }, repo);
  });

  it('happy path — looks up all approved for a tenant', async () => {
    const results = await lookupApprovedEstimates('t1', {}, repo);
    expect(results).toHaveLength(3);
  });

  it('happy path — filters by verticalType', async () => {
    const results = await lookupApprovedEstimates('t1', { verticalType: 'hvac' }, repo);
    expect(results).toHaveLength(2);
  });

  it('happy path — filters by serviceCategory', async () => {
    const results = await lookupApprovedEstimates('t1', { serviceCategory: 'drain' }, repo);
    expect(results).toHaveLength(1);
    expect(results[0].estimateId).toBe('est-3');
  });

  it('happy path — filters by date range', async () => {
    const results = await lookupApprovedEstimates('t1', {
      dateRange: { from: new Date('2024-02-01'), to: new Date('2024-03-31') },
    }, repo);
    expect(results).toHaveLength(2);
  });

  it('tenant isolation — only returns specified tenant', async () => {
    const results = await lookupApprovedEstimates('t2', {}, repo);
    expect(results).toHaveLength(1);
    expect(results[0].estimateId).toBe('est-4');
  });
});
