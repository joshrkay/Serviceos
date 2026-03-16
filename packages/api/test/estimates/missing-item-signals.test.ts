import {
  InMemoryMissingItemSignalRepository,
  storeMissingItemSignal,
  getMissingItemSignals,
  validateMissingItemSignal,
} from '../../src/estimates/missing-item-signals';

describe('P4-008B — Missing-item suggestion signals', () => {
  let repo: InMemoryMissingItemSignalRepository;

  beforeEach(() => {
    repo = new InMemoryMissingItemSignalRepository();
  });

  it('happy path — stores missing item signals from repeated items', async () => {
    const repeatedItems = [
      { description: 'Diagnostic fee', normalizedDescription: 'diagnostic fee', frequency: 5, tenantId: 't1', verticalType: 'hvac' as const },
      { description: 'Travel charge', normalizedDescription: 'travel charge', frequency: 3, tenantId: 't1', verticalType: 'hvac' as const },
    ];

    const signals = storeMissingItemSignal(repeatedItems);
    expect(signals).toHaveLength(2);
    expect(signals[0].description).toBe('Diagnostic fee');
    expect(signals[0].frequency).toBe(5);
    expect(signals[0].recencyScore).toBeGreaterThan(0);
  });

  it('happy path — retrieves signals with filters', async () => {
    const signals = storeMissingItemSignal([
      { description: 'Diagnostic fee', normalizedDescription: 'diagnostic fee', frequency: 4, tenantId: 't1', verticalType: 'hvac' as const },
    ]);
    for (const s of signals) {
      await repo.create(s);
    }

    const found = await getMissingItemSignals('t1', { verticalType: 'hvac' }, repo);
    expect(found).toHaveLength(1);
  });

  it('validation — rejects missing tenantId', () => {
    const errors = validateMissingItemSignal({ description: 'test', frequency: 1, recencyScore: 0.5 });
    expect(errors).toContain('tenantId is required');
  });

  it('validation — rejects invalid recencyScore', () => {
    const errors = validateMissingItemSignal({ tenantId: 't1', description: 'test', recencyScore: 1.5 });
    expect(errors).toContain('recencyScore must be between 0 and 1');
  });

  it('tenant isolation — filters by tenant', async () => {
    const s1 = storeMissingItemSignal([
      { description: 'Item A', normalizedDescription: 'item a', frequency: 2, tenantId: 't1' },
    ]);
    const s2 = storeMissingItemSignal([
      { description: 'Item B', normalizedDescription: 'item b', frequency: 3, tenantId: 't2' },
    ]);
    for (const s of [...s1, ...s2]) await repo.create(s);

    const t1Results = await getMissingItemSignals('t1', {}, repo);
    expect(t1Results).toHaveLength(1);
    expect(t1Results[0].description).toBe('Item A');
  });
});
