import {
  assembleEstimateReference,
  InMemoryEstimateReferenceRepository,
} from '../../src/invoices/invoice-context';

describe('P5-002C — Optional estimate reference in invoice context', () => {
  let estimateRepo: InMemoryEstimateReferenceRepository;

  const tenantId = 'tenant-1';
  const jobId = 'job-1';

  beforeEach(() => {
    estimateRepo = new InMemoryEstimateReferenceRepository();
  });

  it('happy path — returns estimate reference with line items', async () => {
    estimateRepo.addEstimate(tenantId, jobId, {
      estimateId: 'est-1',
      estimateNumber: 'EST-001',
      status: 'accepted',
      lineItems: [
        { description: 'AC Repair', quantity: 2, unitPriceCents: 7500, totalCents: 15000 },
        { description: 'Parts', quantity: 1, unitPriceCents: 5000, totalCents: 5000 },
      ],
      totalCents: 20000,
      approvedAt: new Date(),
    });

    const ref = await assembleEstimateReference(tenantId, jobId, estimateRepo);

    expect(ref).not.toBeNull();
    expect(ref!.estimateId).toBe('est-1');
    expect(ref!.lineItems).toHaveLength(2);
    expect(ref!.totalCents).toBe(20000);
  });

  it('returns null when no approved estimate', async () => {
    const ref = await assembleEstimateReference(tenantId, jobId, estimateRepo);
    expect(ref).toBeNull();
  });

  it('returns null for non-accepted estimate', async () => {
    estimateRepo.addEstimate(tenantId, jobId, {
      estimateId: 'est-1',
      estimateNumber: 'EST-001',
      status: 'draft',
      lineItems: [{ description: 'Test', quantity: 1, unitPriceCents: 1000, totalCents: 1000 }],
      totalCents: 1000,
    });

    const ref = await assembleEstimateReference(tenantId, jobId, estimateRepo);
    expect(ref).toBeNull();
  });

  it('tenant isolation — cross-tenant estimate inaccessible', async () => {
    estimateRepo.addEstimate(tenantId, jobId, {
      estimateId: 'est-1',
      estimateNumber: 'EST-001',
      status: 'accepted',
      lineItems: [{ description: 'Test', quantity: 1, unitPriceCents: 1000, totalCents: 1000 }],
      totalCents: 1000,
    });

    const ref = await assembleEstimateReference('tenant-2', jobId, estimateRepo);
    expect(ref).toBeNull();
  });

  it('validation — returns null for empty tenantId', async () => {
    const ref = await assembleEstimateReference('', jobId, estimateRepo);
    expect(ref).toBeNull();
  });

  it('validation — returns null for empty jobId', async () => {
    const ref = await assembleEstimateReference(tenantId, '', estimateRepo);
    expect(ref).toBeNull();
  });

  it('mock provider — InMemory repository works correctly', async () => {
    estimateRepo.addEstimate(tenantId, jobId, {
      estimateId: 'est-1',
      estimateNumber: 'EST-001',
      status: 'accepted',
      lineItems: [],
      totalCents: 0,
    });

    const ref = await assembleEstimateReference(tenantId, jobId, estimateRepo);
    expect(ref).not.toBeNull();
  });
});
