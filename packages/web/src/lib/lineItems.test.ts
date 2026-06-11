import { describe, it, expect } from 'vitest';
import { uiLineItemsToApiPayload } from './lineItems';

describe('uiLineItemsToApiPayload', () => {
  it('converts dollar rates to integer cents with consistent totals', () => {
    const payload = uiLineItemsToApiPayload([
      { description: 'Labor', qty: 2, rate: 95.5 },
      { description: 'Part', qty: 1, rate: 49.99 },
    ]);

    expect(payload).toHaveLength(2);
    expect(payload[0].unitPriceCents).toBe(9550);
    expect(payload[0].totalCents).toBe(19100);
    expect(payload[1].unitPriceCents).toBe(4999);
    expect(payload[1].totalCents).toBe(4999);
    expect(Number.isInteger(payload[0].totalCents)).toBe(true);
  });
});
