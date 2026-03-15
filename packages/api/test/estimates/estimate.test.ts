import {
  createEstimate,
  approveEstimate,
  rejectEstimate,
  validateEstimateInput,
  InMemoryEstimateRepository,
} from '../../src/estimates/estimate';

describe('P1-009A — Estimate domain model stub', () => {
  it('happy path — creates estimate with all fields', () => {
    const estimate = createEstimate({
      tenantId: 'tenant-1',
      lineItems: [{ id: 'li-1', description: 'Replace filter', quantity: 1, unitPrice: 50, total: 50 }],
      snapshot: { jobType: 'repair' },
      source: 'ai_generated',
      createdBy: 'user-1',
    });

    expect(estimate.id).toBeTruthy();
    expect(estimate.status).toBe('draft');
    expect(estimate.tenantId).toBe('tenant-1');
    expect(estimate.lineItems).toHaveLength(1);
    expect(estimate.createdAt).toBeInstanceOf(Date);
  });

  it('happy path — approve and reject transitions', () => {
    const estimate = createEstimate({
      tenantId: 'tenant-1',
      lineItems: [],
      snapshot: {},
      source: 'manual',
      createdBy: 'user-1',
    });

    const approved = approveEstimate(estimate, 'manager-1');
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe('manager-1');
    expect(approved.approvedAt).toBeInstanceOf(Date);

    const rejected = rejectEstimate(estimate);
    expect(rejected.status).toBe('rejected');
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateEstimateInput({
      tenantId: '',
      lineItems: null as any,
      snapshot: null as any,
      source: '' as any,
      createdBy: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('createdBy is required');
    expect(errors).toContain('source is required');
    expect(errors).toContain('lineItems must be an array');
    expect(errors).toContain('snapshot must be a non-null object');
  });

  it('mock provider test — repository stores and retrieves', async () => {
    const repo = new InMemoryEstimateRepository();
    const estimate = createEstimate({
      tenantId: 'tenant-1',
      lineItems: [{ id: 'li-1', description: 'Test', quantity: 1, unitPrice: 100, total: 100 }],
      snapshot: {},
      source: 'manual',
      createdBy: 'user-1',
    });
    await repo.create(estimate);

    const found = await repo.findById('tenant-1', estimate.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(estimate.id);
  });

  it('mock provider test — repository isolates tenants', async () => {
    const repo = new InMemoryEstimateRepository();
    const estimate = createEstimate({
      tenantId: 'tenant-1',
      lineItems: [],
      snapshot: {},
      source: 'manual',
      createdBy: 'user-1',
    });
    await repo.create(estimate);

    const found = await repo.findById('other-tenant', estimate.id);
    expect(found).toBeNull();
  });

  it('mock provider test — findApproved returns only approved estimates', async () => {
    const repo = new InMemoryEstimateRepository();
    const est1 = createEstimate({ tenantId: 't1', lineItems: [], snapshot: {}, source: 'manual', createdBy: 'u1' });
    const est2 = createEstimate({ tenantId: 't1', lineItems: [], snapshot: {}, source: 'manual', createdBy: 'u1' });
    await repo.create(est1);
    const approved = approveEstimate(est2, 'mgr');
    await repo.create(approved);

    const results = await repo.findApproved('t1');
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('approved');
  });

  it('malformed AI output handled gracefully — rejectEstimate preserves data', () => {
    const estimate = createEstimate({
      tenantId: 'tenant-1',
      lineItems: [],
      snapshot: { malformed: true },
      source: 'ai_generated',
      createdBy: 'user-1',
    });
    const rejected = rejectEstimate(estimate);
    expect(rejected.status).toBe('rejected');
    expect(rejected.snapshot).toEqual({ malformed: true });
  });
});
