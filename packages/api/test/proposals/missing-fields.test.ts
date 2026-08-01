import { describe, it, expect } from 'vitest';
import { clearSatisfiedMissingFields } from '../../src/proposals/missing-fields';

describe('B1 — clearSatisfiedMissingFields (clear-on-fill, not a schema recompute)', () => {
  it('clears a flat key that was edited and is now non-empty', () => {
    const result = clearSatisfiedMissingFields(
      ['invoiceId'],
      ['invoiceId'],
      { invoiceId: '550e8400-e29b-41d4-a716-446655440000', channel: 'email' },
    );
    expect(result).toEqual([]);
  });

  it('leaves the gate intact when a different field was edited', () => {
    const result = clearSatisfiedMissingFields(
      ['invoiceId'],
      ['channel'],
      { invoiceReference: 'Henderson', channel: 'sms' },
    );
    expect(result).toEqual(['invoiceId']);
  });

  it('leaves the gate intact when the edited value is an empty string', () => {
    const result = clearSatisfiedMissingFields(
      ['invoiceId'],
      ['invoiceId'],
      { invoiceId: '   ', channel: 'email' },
    );
    expect(result).toEqual(['invoiceId']);
  });

  it('leaves the gate intact when the edited value is null or undefined', () => {
    expect(
      clearSatisfiedMissingFields(['jobId'], ['jobId'], { jobId: null }),
    ).toEqual(['jobId']);
    expect(
      clearSatisfiedMissingFields(['jobId'], ['jobId'], { jobId: undefined }),
    ).toEqual(['jobId']);
  });

  it('never clears a path-shaped entry even when the exact string is "edited"', () => {
    const result = clearSatisfiedMissingFields(
      ['lineItems[0].catalogItemId', 'editActions[0].lineItem.catalogItemId'],
      ['lineItems[0].catalogItemId', 'editActions[0].lineItem.catalogItemId'],
      {
        'lineItems[0].catalogItemId': 'cat-123',
        'editActions[0].lineItem.catalogItemId': 'cat-456',
      },
    );
    expect(result).toEqual([
      'lineItems[0].catalogItemId',
      'editActions[0].lineItem.catalogItemId',
    ]);
  });

  it('only clears the entries that were both edited and filled, leaving the rest', () => {
    const result = clearSatisfiedMissingFields(
      ['invoiceId', 'estimateId', 'lineItems[0].catalogItemId'],
      ['invoiceId', 'estimateId'],
      {
        invoiceId: '550e8400-e29b-41d4-a716-446655440000',
        estimateId: '', // edited but still empty
        'lineItems[0].catalogItemId': 'cat-123',
      },
    );
    expect(result).toEqual(['estimateId', 'lineItems[0].catalogItemId']);
  });

  it('returns an empty array unchanged and does not mutate the input array', () => {
    const input: string[] = [];
    const result = clearSatisfiedMissingFields(input, ['invoiceId'], { invoiceId: 'x' });
    expect(result).toEqual([]);
    expect(input).toEqual([]);
  });
});
