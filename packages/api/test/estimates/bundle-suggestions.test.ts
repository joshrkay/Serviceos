import { suggestBundles, detectBundlePatterns, scoreBundleRelevance } from '../../src/estimates/bundle-suggestions';
import { createLineItemBundle, InMemoryLineItemBundleRepository } from '../../src/estimates/line-item-bundle';
import { InMemoryEstimateSummaryRepository } from '../../src/estimates/estimate-summary';

describe('P4-006B — Bundle suggestions from approved history', () => {
  it('happy path — suggests bundles sorted by confidence', async () => {
    const bundleRepo = new InMemoryLineItemBundleRepository();
    const summaryRepo = new InMemoryEstimateSummaryRepository();

    const b1 = createLineItemBundle({
      tenantId: 'tenant-1',
      verticalSlug: 'hvac',
      categoryId: 'hvac-repair',
      name: 'AC Repair Bundle',
      description: 'Common AC repair items',
      items: [{ description: 'Diagnostic', isRequired: true, sortOrder: 1 }],
    });
    (b1 as any).confidence = 0.8;
    await bundleRepo.create(b1);

    const suggestions = await suggestBundles(
      { tenantId: 'tenant-1', verticalSlug: 'hvac', categoryId: 'hvac-repair' },
      bundleRepo, summaryRepo
    );
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    expect(suggestions[0].bundle.name).toBe('AC Repair Bundle');
  });

  it('happy path — scoreBundleRelevance scores matches', () => {
    const bundle = createLineItemBundle({
      tenantId: 't', verticalSlug: 'v', name: 'n', description: 'd',
      items: [
        { description: 'Diagnostic fee', isRequired: true, sortOrder: 1 },
        { description: 'Capacitor', isRequired: true, sortOrder: 2 },
      ],
    });
    const score = scoreBundleRelevance(bundle, [
      { id: '1', description: 'Diagnostic fee', quantity: 1, unitPrice: 89, total: 89 },
    ]);
    expect(score).toBe(0.5); // 1 of 2 items matched
  });

  it('validation — detectBundlePatterns finds repeated item sets', () => {
    const summaries = [
      { id: '1', tenantId: 't', estimateId: 'e1', verticalSlug: 'hvac', categoryId: 'r', summaryText: '', lineItemSummaries: [{ description: 'A', quantity: 1, unitPrice: 10 }, { description: 'B', quantity: 1, unitPrice: 20 }], totalAmount: 30, keyTerms: [], createdAt: new Date() },
      { id: '2', tenantId: 't', estimateId: 'e2', verticalSlug: 'hvac', categoryId: 'r', summaryText: '', lineItemSummaries: [{ description: 'A', quantity: 1, unitPrice: 10 }, { description: 'B', quantity: 1, unitPrice: 20 }], totalAmount: 30, keyTerms: [], createdAt: new Date() },
      { id: '3', tenantId: 't', estimateId: 'e3', verticalSlug: 'hvac', categoryId: 'r', summaryText: '', lineItemSummaries: [{ description: 'C', quantity: 1, unitPrice: 50 }], totalAmount: 50, keyTerms: [], createdAt: new Date() },
    ];
    const patterns = detectBundlePatterns(summaries, 2);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].frequency).toBe(2);
  });

  it('mock provider test — respects limit', async () => {
    const bundleRepo = new InMemoryLineItemBundleRepository();
    const summaryRepo = new InMemoryEstimateSummaryRepository();

    for (let i = 0; i < 10; i++) {
      const b = createLineItemBundle({ tenantId: 'tenant-1', verticalSlug: 'hvac', name: `B${i}`, description: 'd', items: [] });
      await bundleRepo.create(b);
    }

    const suggestions = await suggestBundles(
      { tenantId: 'tenant-1', verticalSlug: 'hvac', limit: 3 },
      bundleRepo, summaryRepo
    );
    expect(suggestions).toHaveLength(3);
  });

  it('malformed AI output handled gracefully — empty bundle items', () => {
    const bundle = createLineItemBundle({ tenantId: 't', verticalSlug: 'v', name: 'n', description: 'd', items: [] });
    const score = scoreBundleRelevance(bundle, [{ id: '1', description: 'Test', quantity: 1, unitPrice: 100, total: 100 }]);
    expect(score).toBe(0);
  });
});
