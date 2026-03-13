import { assembleHistoryContext, assembleFullEstimateContext } from '../../src/ai/tasks/estimate-context';
import { InMemoryEstimateSummarySnapshotRepository, createEstimateSummarySnapshot } from '../../src/estimates/estimate-snapshots';
import { InMemoryBundlePatternRepository } from '../../src/estimates/bundle-patterns';
import { InMemoryWordingPreferenceRepository } from '../../src/estimates/wording-preferences';
import { InMemoryMissingItemSignalRepository, storeMissingItemSignal } from '../../src/estimates/missing-item-signals';

describe('P4-009C — History- and signal-aware context assembly', () => {
  let snapshotRepo: InMemoryEstimateSummarySnapshotRepository;
  let bundleRepo: InMemoryBundlePatternRepository;
  let wordingRepo: InMemoryWordingPreferenceRepository;
  let missingItemRepo: InMemoryMissingItemSignalRepository;

  beforeEach(async () => {
    snapshotRepo = new InMemoryEstimateSummarySnapshotRepository();
    bundleRepo = new InMemoryBundlePatternRepository();
    wordingRepo = new InMemoryWordingPreferenceRepository();
    missingItemRepo = new InMemoryMissingItemSignalRepository();

    // Seed data
    const snap = createEstimateSummarySnapshot('t1', 'est-1', ['Diagnostic fee', 'Inspection'], 15000, 'approved', { verticalType: 'hvac' });
    await snapshotRepo.create(snap);

    await bundleRepo.create({
      id: 'bp-1', tenantId: 't1', verticalType: 'hvac', items: [
        { description: 'Diagnostic fee', normalizedDescription: 'diagnostic fee' },
        { description: 'Inspection', normalizedDescription: 'inspection' },
      ], frequency: 5, confidence: 0.8, lastSeenAt: new Date(),
    });

    await wordingRepo.upsert('t1', 'ac repair', 'air conditioning repair', 'hvac');

    const signals = storeMissingItemSignal([
      { description: 'Travel charge', normalizedDescription: 'travel charge', frequency: 3, tenantId: 't1', verticalType: 'hvac' as const },
    ]);
    for (const s of signals) await missingItemRepo.create(s);
  });

  it('happy path — assembles all history signals', async () => {
    const context = await assembleHistoryContext('t1', 'hvac', undefined, {
      snapshotRepo, bundleRepo, wordingRepo, missingItemRepo,
    });

    expect(context.approvedExamples.length).toBeGreaterThan(0);
    expect(context.bundleSuggestions.length).toBeGreaterThan(0);
    expect(context.wordingPreferences.length).toBeGreaterThan(0);
    expect(context.missingItemSignals.length).toBeGreaterThan(0);
  });

  it('happy path — partial signals when some repos missing', async () => {
    const context = await assembleHistoryContext('t1', 'hvac', undefined, {
      snapshotRepo,
    });

    expect(context.approvedExamples.length).toBeGreaterThan(0);
    expect(context.bundleSuggestions).toHaveLength(0);
    expect(context.wordingPreferences).toHaveLength(0);
    expect(context.missingItemSignals).toHaveLength(0);
  });

  it('happy path — empty history for new tenant', async () => {
    const context = await assembleHistoryContext('t-new', undefined, undefined, {
      snapshotRepo, bundleRepo, wordingRepo, missingItemRepo,
    });

    expect(context.approvedExamples).toHaveLength(0);
    expect(context.bundleSuggestions).toHaveLength(0);
    expect(context.wordingPreferences).toHaveLength(0);
    expect(context.missingItemSignals).toHaveLength(0);
  });

  it('happy path — no repos returns all empty', async () => {
    const context = await assembleHistoryContext('t1');
    expect(context.approvedExamples).toHaveLength(0);
    expect(context.bundleSuggestions).toHaveLength(0);
  });

  it('happy path — trims history when context would exceed token budget', async () => {
    // Seed many snapshots with very long descriptions to push context over MAX_CONTEXT_TOKENS (8000 ≈ 32K chars)
    for (let i = 0; i < 5; i++) {
      const longItems = Array.from({ length: 50 }, (_, j) => `Line item ${i}-${j}: ${'X'.repeat(200)} detailed description for budget test`);
      const snap = createEstimateSummarySnapshot('t1', `est-large-${i}`, longItems, 50000, 'approved', { verticalType: 'hvac', customerMessage: 'A'.repeat(500) });
      await snapshotRepo.create(snap);
    }

    // Seed many wording preferences
    for (let i = 0; i < 10; i++) {
      await wordingRepo.upsert('t1', `original phrase ${i} that is somewhat long`, `preferred phrase ${i} that is also somewhat long`, 'hvac');
    }

    const full = await assembleFullEstimateContext(
      { tenant: { name: 'Test' } },
      null, null, 't1', 'hvac', undefined,
      { snapshotRepo, bundleRepo, wordingRepo, missingItemRepo }
    );

    // History should be trimmed — fewer approved examples than the 5 max
    expect(full.history.approvedExamples.length).toBeLessThanOrEqual(3);
  });

  it('mock provider — full context assembly combines vertical and history', async () => {
    const full = await assembleFullEstimateContext(
      { tenant: { name: 'Test' } },
      null, null, 't1', 'hvac', undefined,
      { snapshotRepo, bundleRepo, wordingRepo, missingItemRepo }
    );

    expect(full.vertical).toBeDefined();
    expect(full.history).toBeDefined();
    expect(full.history.approvedExamples.length).toBeGreaterThan(0);
  });
});
