import {
  InMemoryEstimateSummarySnapshotRepository,
  createEstimateSummarySnapshot,
  validateSnapshot,
} from '../../src/estimates/estimate-snapshots';

describe('P4-005C — Retrieval-ready estimate summary snapshots', () => {
  let repo: InMemoryEstimateSummarySnapshotRepository;

  beforeEach(() => {
    repo = new InMemoryEstimateSummarySnapshotRepository();
  });

  it('happy path — creates compact snapshot', async () => {
    const snapshot = createEstimateSummarySnapshot(
      't1', 'est-1',
      ['Diagnostic fee', 'System inspection', 'Report'],
      15000, 'approved',
      { verticalType: 'hvac', serviceCategory: 'diagnostic', customerMessage: 'Thanks for the quick service' }
    );

    expect(snapshot.id).toBeDefined();
    expect(snapshot.lineItemDescriptions).toHaveLength(3);
    expect(snapshot.totalCents).toBe(15000);
    expect(snapshot.verticalType).toBe('hvac');

    await repo.create(snapshot);
    const found = await repo.findByTenant('t1');
    expect(found).toHaveLength(1);
  });

  it('happy path — filters snapshots by vertical', async () => {
    const snap1 = createEstimateSummarySnapshot('t1', 'est-1', ['A'], 1000, 'approved', { verticalType: 'hvac' });
    const snap2 = createEstimateSummarySnapshot('t1', 'est-2', ['B'], 2000, 'approved', { verticalType: 'plumbing' });
    await repo.create(snap1);
    await repo.create(snap2);

    const hvac = await repo.findByFilters('t1', { verticalType: 'hvac' });
    expect(hvac).toHaveLength(1);
    expect(hvac[0].estimateId).toBe('est-1');
  });

  it('happy path — limits results', async () => {
    for (let i = 0; i < 5; i++) {
      const snap = createEstimateSummarySnapshot('t1', `est-${i}`, ['Item'], 1000, 'approved');
      await repo.create(snap);
    }

    const limited = await repo.findByFilters('t1', { limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it('validation — rejects missing tenantId', () => {
    const errors = validateSnapshot({ estimateId: 'est-1', approvalOutcome: 'approved', totalCents: 100 });
    expect(errors).toContain('tenantId is required');
  });

  it('validation — rejects negative totalCents', () => {
    const errors = validateSnapshot({ tenantId: 't1', estimateId: 'est-1', approvalOutcome: 'approved', totalCents: -100 });
    expect(errors).toContain('totalCents must be non-negative');
  });
});
