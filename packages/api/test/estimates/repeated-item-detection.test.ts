import { InMemoryEditDeltaRepository } from '../../src/estimates/edit-delta';
import { detectRepeatedlyAddedItems, normalizeDescription } from '../../src/estimates/repeated-item-detection';

describe('P4-008A — Repeatedly added line-item detection', () => {
  let deltaRepo: InMemoryEditDeltaRepository;

  beforeEach(() => {
    deltaRepo = new InMemoryEditDeltaRepository();
  });

  it('happy path — detects repeatedly added items', async () => {
    await deltaRepo.create({
      id: 'd1', tenantId: 't1', estimateId: 'est-1', fromRevisionId: 'r1', toRevisionId: 'r2',
      deltas: [
        { type: 'line_item_added', lineItemId: 'li-1', newValue: { description: 'Diagnostic fee' } },
      ],
      summary: '1 item(s) added',
      createdAt: new Date(),
    });
    await deltaRepo.create({
      id: 'd2', tenantId: 't1', estimateId: 'est-2', fromRevisionId: 'r3', toRevisionId: 'r4',
      deltas: [
        { type: 'line_item_added', lineItemId: 'li-2', newValue: { description: 'Diagnostic fee' } },
        { type: 'line_item_added', lineItemId: 'li-3', newValue: { description: 'Travel charge' } },
      ],
      summary: '2 item(s) added',
      createdAt: new Date(),
    });
    await deltaRepo.create({
      id: 'd3', tenantId: 't1', estimateId: 'est-3', fromRevisionId: 'r5', toRevisionId: 'r6',
      deltas: [
        { type: 'line_item_added', lineItemId: 'li-4', newValue: { description: 'Diagnostic Fee' } },
      ],
      summary: '1 item(s) added',
      createdAt: new Date(),
    });

    const signals = await detectRepeatedlyAddedItems('t1', ['est-1', 'est-2', 'est-3'], deltaRepo, { minFrequency: 2 });
    expect(signals.length).toBeGreaterThan(0);
    const diagSignal = signals.find((s) => s.normalizedDescription === 'diagnostic fee');
    expect(diagSignal).toBeDefined();
    expect(diagSignal!.frequency).toBe(3);
  });

  it('happy path — normalizes descriptions correctly', () => {
    expect(normalizeDescription('  Diagnostic  Fee  ')).toBe('diagnostic fee');
    expect(normalizeDescription('DRAIN CLEANING')).toBe('drain cleaning');
  });

  it('validation — respects minFrequency threshold', async () => {
    await deltaRepo.create({
      id: 'd1', tenantId: 't1', estimateId: 'est-1', fromRevisionId: 'r1', toRevisionId: 'r2',
      deltas: [
        { type: 'line_item_added', lineItemId: 'li-1', newValue: { description: 'Unique item' } },
      ],
      summary: '1 item(s) added',
      createdAt: new Date(),
    });

    const signals = await detectRepeatedlyAddedItems('t1', ['est-1'], deltaRepo, { minFrequency: 2 });
    expect(signals).toHaveLength(0);
  });

  it('edge case — empty deltas returns empty signals', async () => {
    const signals = await detectRepeatedlyAddedItems('t1', [], deltaRepo);
    expect(signals).toHaveLength(0);
  });
});
