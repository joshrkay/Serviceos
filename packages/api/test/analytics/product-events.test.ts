import { describe, it, expect } from 'vitest';
import {
  PRODUCT_EVENT_NAMES,
  isProductEventName,
} from '../../src/analytics/product-events';

describe('product-event catalog', () => {
  it('has no duplicate names', () => {
    const unique = new Set(PRODUCT_EVENT_NAMES);
    expect(unique.size).toBe(PRODUCT_EVENT_NAMES.length);
  });

  it('recognizes catalogued names and rejects others', () => {
    for (const name of PRODUCT_EVENT_NAMES) {
      expect(isProductEventName(name)).toBe(true);
    }
    expect(isProductEventName('proposal.one_tap_approved')).toBe(false); // raw audit string, not a product name
    expect(isProductEventName('totally_made_up')).toBe(false);
  });
});
