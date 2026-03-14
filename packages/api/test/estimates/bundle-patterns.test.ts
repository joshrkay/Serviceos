import {
  InMemoryBundlePatternRepository,
  validateBundlePattern,
  identifyBundlePatterns,
  BundlePattern,
} from '../../src/estimates/bundle-patterns';
import { ApprovedEstimateMetadata } from '../../src/estimates/approved-estimate-metadata';

describe('P4-006A — Line-item bundle pattern model', () => {
  let repo: InMemoryBundlePatternRepository;

  beforeEach(() => {
    repo = new InMemoryBundlePatternRepository();
  });

  it('happy path — creates and retrieves bundle pattern', async () => {
    const pattern: BundlePattern = {
      id: 'bp-1',
      tenantId: 't1',
      verticalType: 'hvac',
      serviceCategory: 'diagnostic',
      items: [
        { description: 'Diagnostic fee', normalizedDescription: 'diagnostic fee' },
        { description: 'Inspection report', normalizedDescription: 'inspection report' },
      ],
      frequency: 5,
      confidence: 0.8,
      lastSeenAt: new Date(),
    };

    const created = await repo.create(pattern);
    expect(created.id).toBe('bp-1');
    expect(created.items).toHaveLength(2);

    const found = await repo.findByTenant('t1');
    expect(found).toHaveLength(1);
  });

  it('happy path — filters by vertical and category', async () => {
    await repo.create({
      id: 'bp-1', tenantId: 't1', verticalType: 'hvac', items: [
        { description: 'A', normalizedDescription: 'a' },
        { description: 'B', normalizedDescription: 'b' },
      ], frequency: 3, confidence: 0.5, lastSeenAt: new Date(),
    });
    await repo.create({
      id: 'bp-2', tenantId: 't1', verticalType: 'plumbing', items: [
        { description: 'C', normalizedDescription: 'c' },
        { description: 'D', normalizedDescription: 'd' },
      ], frequency: 2, confidence: 0.4, lastSeenAt: new Date(),
    });

    const hvac = await repo.findByFilters('t1', { verticalType: 'hvac' });
    expect(hvac).toHaveLength(1);
    expect(hvac[0].id).toBe('bp-1');
  });

  it('validation — rejects bundle with less than 2 items', () => {
    const errors = validateBundlePattern({
      tenantId: 't1',
      items: [{ description: 'A', normalizedDescription: 'a' }],
      frequency: 2,
      confidence: 0.5,
    });
    expect(errors).toContain('Bundle must have at least 2 items');
  });

  it('identifies co-occurring pairs above min frequency', async () => {
    const base = { approvalOutcome: 'approved' as const, lineItemCount: 2, totalCents: 10000, approvedAt: new Date() };
    const estimates: ApprovedEstimateMetadata[] = [
      { id: 'a1', tenantId: 't1', estimateId: 'e1', lineItemSummary: ['Diagnostic fee', 'Inspection report'], ...base },
      { id: 'a2', tenantId: 't1', estimateId: 'e2', lineItemSummary: ['Diagnostic fee', 'Inspection report'], ...base },
      { id: 'a3', tenantId: 't1', estimateId: 'e3', lineItemSummary: ['Diagnostic fee', 'Other item'], ...base },
    ];

    const patterns = await identifyBundlePatterns('t1', estimates, { minFrequency: 2 });
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    const topPattern = patterns[0];
    expect(topPattern.frequency).toBe(2);
    expect(topPattern.items).toHaveLength(2);
  });

  it('returns empty when no pairs meet min frequency', async () => {
    const base = { approvalOutcome: 'approved' as const, lineItemCount: 2, totalCents: 5000, approvedAt: new Date() };
    const estimates: ApprovedEstimateMetadata[] = [
      { id: 'a1', tenantId: 't1', estimateId: 'e1', lineItemSummary: ['A', 'B'], ...base },
      { id: 'a2', tenantId: 't1', estimateId: 'e2', lineItemSummary: ['C', 'D'], ...base },
    ];

    const patterns = await identifyBundlePatterns('t1', estimates, { minFrequency: 2 });
    expect(patterns).toHaveLength(0);
  });

  it('validation — rejects invalid confidence', () => {
    const errors = validateBundlePattern({
      tenantId: 't1',
      items: [
        { description: 'A', normalizedDescription: 'a' },
        { description: 'B', normalizedDescription: 'b' },
      ],
      frequency: 2,
      confidence: 1.5,
    });
    expect(errors).toContain('confidence must be between 0 and 1');
  });
});
