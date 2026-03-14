import {
  InMemoryBundlePatternRepository,
  identifyBundlePatterns,
  suggestBundles,
} from '../../src/estimates/bundle-patterns';
import { ApprovedEstimateMetadata } from '../../src/estimates/approved-estimate-metadata';

describe('P4-006B — Bundle suggestions from approved history', () => {
  it('happy path — identifies bundle patterns from approved estimates', async () => {
    const estimates: ApprovedEstimateMetadata[] = [
      { id: '1', tenantId: 't1', estimateId: 'e1', approvalOutcome: 'approved', approvedAt: new Date(), lineItemCount: 2, totalCents: 10000, lineItemSummary: ['Diagnostic fee', 'Inspection report'] },
      { id: '2', tenantId: 't1', estimateId: 'e2', approvalOutcome: 'approved', approvedAt: new Date(), lineItemCount: 2, totalCents: 12000, lineItemSummary: ['Diagnostic fee', 'Inspection report'] },
      { id: '3', tenantId: 't1', estimateId: 'e3', approvalOutcome: 'approved', approvedAt: new Date(), lineItemCount: 3, totalCents: 15000, lineItemSummary: ['Diagnostic fee', 'Inspection report', 'Travel'] },
    ];

    const patterns = await identifyBundlePatterns('t1', estimates, { minFrequency: 2 });
    expect(patterns.length).toBeGreaterThan(0);
    const diagBundle = patterns.find((p) =>
      p.items.some((i) => i.normalizedDescription === 'diagnostic fee') &&
      p.items.some((i) => i.normalizedDescription === 'inspection report')
    );
    expect(diagBundle).toBeDefined();
    expect(diagBundle!.frequency).toBeGreaterThanOrEqual(2);
  });

  it('happy path — suggests bundles based on current items', async () => {
    const repo = new InMemoryBundlePatternRepository();
    await repo.create({
      id: 'bp-1', tenantId: 't1', items: [
        { description: 'Diagnostic fee', normalizedDescription: 'diagnostic fee' },
        { description: 'Inspection report', normalizedDescription: 'inspection report' },
      ], frequency: 5, confidence: 0.8, lastSeenAt: new Date(),
    });

    const suggestions = await suggestBundles('t1', ['Diagnostic fee'], repo);
    expect(suggestions).toHaveLength(1);
  });

  it('edge case — no history returns empty', async () => {
    const patterns = await identifyBundlePatterns('t1', [], { minFrequency: 2 });
    expect(patterns).toHaveLength(0);
  });

  it('edge case — no suggestions when all items already present', async () => {
    const repo = new InMemoryBundlePatternRepository();
    await repo.create({
      id: 'bp-1', tenantId: 't1', items: [
        { description: 'A', normalizedDescription: 'a' },
        { description: 'B', normalizedDescription: 'b' },
      ], frequency: 3, confidence: 0.7, lastSeenAt: new Date(),
    });

    const suggestions = await suggestBundles('t1', ['A', 'B'], repo);
    expect(suggestions).toHaveLength(0);
  });

  it('false positive prevention — low frequency patterns excluded', async () => {
    const estimates: ApprovedEstimateMetadata[] = [
      { id: '1', tenantId: 't1', estimateId: 'e1', approvalOutcome: 'approved', approvedAt: new Date(), lineItemCount: 2, totalCents: 10000, lineItemSummary: ['Unique A', 'Unique B'] },
    ];

    const patterns = await identifyBundlePatterns('t1', estimates, { minFrequency: 3 });
    expect(patterns).toHaveLength(0);
  });
});
