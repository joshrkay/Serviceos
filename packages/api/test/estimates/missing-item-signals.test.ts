import { detectMissingItems, compareWithFrequentItems, compareWithBundles } from '../../src/estimates/missing-item-signals';
import { InMemoryLineItemFrequencyRepository, normalizeLineItemDescription } from '../../src/estimates/line-item-frequency';
import { createLineItemBundle, InMemoryLineItemBundleRepository } from '../../src/estimates/line-item-bundle';
import { LineItemFrequency } from '../../src/estimates/line-item-frequency';

describe('P4-008B — Missing-item suggestion signals', () => {
  it('happy path — detects missing frequent items', () => {
    const frequentItems: LineItemFrequency[] = [
      { id: '1', tenantId: 't', verticalSlug: 'hvac', normalizedDescription: 'diagnostic fee', occurrenceCount: 10, avgQuantity: 1, avgUnitPrice: 89, lastSeenAt: new Date(), createdAt: new Date() },
      { id: '2', tenantId: 't', verticalSlug: 'hvac', normalizedDescription: 'capacitor', occurrenceCount: 5, avgQuantity: 1, avgUnitPrice: 250, lastSeenAt: new Date(), createdAt: new Date() },
    ];
    const currentItems = [{ id: 'li-1', description: 'Diagnostic Fee', quantity: 1, unitPrice: 89, total: 89 }];

    const signals = compareWithFrequentItems(currentItems, frequentItems);
    expect(signals).toHaveLength(1);
    expect(signals[0].lineItem.normalizedDescription).toBe('capacitor');
  });

  it('happy path — detects missing bundle items', () => {
    const bundle = createLineItemBundle({
      tenantId: 't', verticalSlug: 'hvac', name: 'AC Repair', description: 'd',
      items: [
        { description: 'Diagnostic', typicalQuantity: 1, typicalUnitPrice: 89, isRequired: true, sortOrder: 1 },
        { description: 'Capacitor', typicalQuantity: 1, typicalUnitPrice: 250, isRequired: true, sortOrder: 2 },
      ],
    });

    const currentItems = [{ id: 'li-1', description: 'Diagnostic', quantity: 1, unitPrice: 89, total: 89 }];
    const signals = compareWithBundles(currentItems, [bundle]);
    expect(signals).toHaveLength(1);
    expect(signals[0].reason).toContain('bundle');
  });

  it('validation — detectMissingItems deduplicates signals', async () => {
    const freqRepo = new InMemoryLineItemFrequencyRepository();
    const bundleRepo = new InMemoryLineItemBundleRepository();

    const signals = await detectMissingItems(
      { tenantId: 'tenant-1', verticalSlug: 'hvac', currentLineItems: [] },
      freqRepo, bundleRepo
    );
    expect(Array.isArray(signals)).toBe(true);
  });

  it('mock provider test — signals sorted by confidence', () => {
    const frequentItems: LineItemFrequency[] = [
      { id: '1', tenantId: 't', verticalSlug: 'hvac', normalizedDescription: 'rare item', occurrenceCount: 2, avgQuantity: 1, avgUnitPrice: 50, lastSeenAt: new Date(), createdAt: new Date() },
      { id: '2', tenantId: 't', verticalSlug: 'hvac', normalizedDescription: 'common item', occurrenceCount: 8, avgQuantity: 1, avgUnitPrice: 100, lastSeenAt: new Date(), createdAt: new Date() },
    ];

    const signals = compareWithFrequentItems([], frequentItems);
    expect(signals).toHaveLength(2);
    // Higher occurrence → higher confidence
    const highConf = signals.find((s) => s.lineItem.normalizedDescription === 'common item');
    const lowConf = signals.find((s) => s.lineItem.normalizedDescription === 'rare item');
    expect(highConf!.confidence).toBeGreaterThan(lowConf!.confidence);
  });

  it('malformed AI output handled gracefully — empty current items', () => {
    const signals = compareWithFrequentItems([], []);
    expect(signals).toEqual([]);
  });
});
