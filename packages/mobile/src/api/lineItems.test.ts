import { describe, expect, it } from 'vitest';
import type { LineItem } from '../components/LineItemSheet';
import { toServerLineItems } from './lineItems';

// The server `lineItemSchema` (packages/api/src/shared/contracts.ts:108-132,
// used by createEstimateSchema) requires id/description/quantity/unitPriceCents/
// totalCents/sortOrder/taxable and accepts the good-better-best fields
// (groupKey/groupLabel min(1) strings, isOptional/isDefaultSelected booleans) as
// optional. These assertions pin the exact serialized shape that schema accepts.

describe('toServerLineItems — flat (single-tier) shape, no regression', () => {
  it('synthesizes id/totalCents/sortOrder/taxable and emits NO tier fields', () => {
    const items: LineItem[] = [
      { description: 'Service call', quantity: 1, unitPriceCents: 9900, catalogItemId: 'cat-2' },
      { description: 'Labor', quantity: 2, unitPriceCents: 5000 },
    ];
    const out = toServerLineItems(items);
    expect(out).toEqual([
      {
        id: 'li-1',
        description: 'Service call',
        quantity: 1,
        unitPriceCents: 9900,
        totalCents: 9900,
        sortOrder: 0,
        taxable: false,
        catalogItemId: 'cat-2',
      },
      {
        id: 'li-2',
        description: 'Labor',
        quantity: 2,
        unitPriceCents: 5000,
        totalCents: 10000,
        sortOrder: 1,
        taxable: false,
      },
    ]);
    // A flat line carries none of the grouping keys — byte-identical to pre-tier.
    for (const li of out) {
      expect(li).not.toHaveProperty('groupKey');
      expect(li).not.toHaveProperty('groupLabel');
      expect(li).not.toHaveProperty('isOptional');
      expect(li).not.toHaveProperty('isDefaultSelected');
    }
  });
});

describe('toServerLineItems — good-better-best passthrough', () => {
  it('forwards groupKey/groupLabel/isOptional/isDefaultSelected verbatim', () => {
    const tiers: LineItem[] = [
      {
        catalogItemId: 'cat-basic',
        description: 'Basic roof',
        quantity: 1,
        unitPriceCents: 500000,
        groupKey: 'tier',
        groupLabel: 'Options',
        isOptional: true,
        isDefaultSelected: true,
      },
      {
        catalogItemId: 'cat-premium',
        description: 'Premium roof',
        quantity: 1,
        unitPriceCents: 1200000,
        groupKey: 'tier',
        groupLabel: 'Options',
        isOptional: true,
        isDefaultSelected: false,
      },
    ];
    const out = toServerLineItems(tiers);
    expect(out[0]).toMatchObject({
      groupKey: 'tier',
      groupLabel: 'Options',
      isOptional: true,
      isDefaultSelected: true,
      totalCents: 500000,
      sortOrder: 0,
    });
    expect(out[1]).toMatchObject({
      groupKey: 'tier',
      groupLabel: 'Options',
      isOptional: true,
      isDefaultSelected: false,
      totalCents: 1200000,
      sortOrder: 1,
    });
    // Exactly one default across the group (the money-safe tier invariant).
    expect(out.filter((li) => li.isDefaultSelected === true)).toHaveLength(1);
  });

  it('emits isDefaultSelected:false explicitly (not dropped) for non-default tiers', () => {
    const [li] = toServerLineItems([
      {
        description: 'Better',
        quantity: 1,
        unitPriceCents: 800000,
        groupKey: 'tier',
        groupLabel: 'Options',
        isOptional: true,
        isDefaultSelected: false,
      },
    ]);
    expect(li.isDefaultSelected).toBe(false);
    expect(li.isOptional).toBe(true);
  });
});
