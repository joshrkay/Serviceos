import {
  normalizeLineItemDescription,
  trackLineItemOccurrence,
  detectFrequentItems,
  InMemoryLineItemFrequencyRepository,
} from '../../src/estimates/line-item-frequency';

describe('P4-008A — Repeatedly added line-item detection', () => {
  it('happy path — normalizeLineItemDescription normalizes text', () => {
    expect(normalizeLineItemDescription('  Capacitor Replacement!  ')).toBe('capacitor replacement');
    expect(normalizeLineItemDescription('Labor - 2 hours.')).toBe('labor 2 hours');
  });

  it('happy path — trackLineItemOccurrence creates new frequency', async () => {
    const repo = new InMemoryLineItemFrequencyRepository();
    const freq = await trackLineItemOccurrence(
      { id: 'li-1', description: 'Capacitor', quantity: 1, unitPrice: 250, total: 250 },
      'tenant-1', 'hvac', 'hvac-repair', repo
    );
    expect(freq.occurrenceCount).toBe(1);
    expect(freq.normalizedDescription).toBe('capacitor');
  });

  it('happy path — trackLineItemOccurrence increments existing', async () => {
    const repo = new InMemoryLineItemFrequencyRepository();
    await trackLineItemOccurrence(
      { id: 'li-1', description: 'Capacitor', quantity: 1, unitPrice: 250, total: 250 },
      'tenant-1', 'hvac', 'hvac-repair', repo
    );
    const freq = await trackLineItemOccurrence(
      { id: 'li-2', description: 'Capacitor', quantity: 2, unitPrice: 200, total: 400 },
      'tenant-1', 'hvac', 'hvac-repair', repo
    );
    expect(freq.occurrenceCount).toBe(2);
    expect(freq.avgQuantity).toBe(1.5);
    expect(freq.avgUnitPrice).toBe(225);
  });

  it('validation — detectFrequentItems filters by threshold', async () => {
    const repo = new InMemoryLineItemFrequencyRepository();
    for (let i = 0; i < 5; i++) {
      await trackLineItemOccurrence(
        { id: `li-${i}`, description: 'Capacitor', quantity: 1, unitPrice: 250, total: 250 },
        'tenant-1', 'hvac', undefined, repo
      );
    }
    await trackLineItemOccurrence(
      { id: 'li-rare', description: 'Rare item', quantity: 1, unitPrice: 500, total: 500 },
      'tenant-1', 'hvac', undefined, repo
    );

    const frequent = await detectFrequentItems('tenant-1', 'hvac', 3, repo);
    expect(frequent).toHaveLength(1);
    expect(frequent[0].normalizedDescription).toBe('capacitor');
  });

  it('mock provider test — repository isolates tenants', async () => {
    const repo = new InMemoryLineItemFrequencyRepository();
    await trackLineItemOccurrence(
      { id: 'li-1', description: 'Test', quantity: 1, unitPrice: 100, total: 100 },
      'tenant-1', 'hvac', undefined, repo
    );

    const results = await repo.findByTenant('other-tenant');
    expect(results).toHaveLength(0);
  });

  it('malformed AI output handled gracefully — empty description normalizes', () => {
    expect(normalizeLineItemDescription('')).toBe('');
    expect(normalizeLineItemDescription('   ')).toBe('');
  });
});
