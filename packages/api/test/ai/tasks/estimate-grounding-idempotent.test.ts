/**
 * WS5 regression — grounding is idempotent.
 *
 * The voice path (handleCreateProposal) now stores PRE-grounded line items on
 * a draft_estimate payload. Grounding must be safe to run again on already-
 * grounded lines: `applyCatalogPricing` rewrites a matched line's description
 * to the catalog item's name, so re-resolving that name yields the SAME exact
 * match, the SAME price, and the SAME pricingSource — no drift, no double
 * charge, no downgrade of a caught match. This pins that invariant so the
 * operator-side EstimateTaskHandler can consume grounded-or-ungrounded
 * payloads without special-casing.
 */
import { describe, it, expect } from 'vitest';
import { groundLineItemPricing } from '../../../src/ai/resolution/catalog-resolver';
import type { CatalogItem } from '../../../src/catalog/catalog-item';

function item(name: string, unitPriceCents: number): CatalogItem {
  const now = new Date().toISOString();
  return {
    id: `c-${name.toLowerCase().replace(/\s+/g, '-')}`,
    tenantId: 't1',
    name,
    description: '',
    category: 'Parts',
    unit: 'each',
    unitPriceCents,
    productServiceType: 'product',
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

const CATALOG: CatalogItem[] = [
  item('Water Heater Replacement', 185000),
  item('Gasket', 450),
];

const loader = () => Promise.resolve(CATALOG);

describe('WS5 — grounding idempotency', () => {
  it('re-grounding already-grounded lines is a fixed point (price + source stable)', async () => {
    const rawLines = [
      { description: 'water heater replacement', quantity: 1 },
      { description: 'gasket', quantity: 2 },
    ];

    const first = await groundLineItemPricing(rawLines, 'unitPrice', loader);
    const second = await groundLineItemPricing(first.lineItems, 'unitPrice', loader);

    expect(second.lineItems).toEqual(first.lineItems);
    expect(second.anyUncatalogued).toBe(first.anyUncatalogued);
    expect(second.anyCatalogPriced).toBe(true);
    // Prices came from the catalog on both passes.
    expect(second.lineItems.map((l) => l.unitPrice)).toEqual([185000, 450]);
    expect(second.lineItems.map((l) => l.pricingSource)).toEqual(['catalog', 'catalog']);
  });

  it('an uncatalogued line stays uncatalogued on a second pass (no silent upgrade)', async () => {
    const rawLines = [{ description: 'bespoke unicorn polish', quantity: 1, unitPrice: 9999 }];
    const first = await groundLineItemPricing(rawLines, 'unitPrice', loader);
    const second = await groundLineItemPricing(first.lineItems, 'unitPrice', loader);
    expect(first.anyUncatalogued).toBe(true);
    expect(second.anyUncatalogued).toBe(true);
    expect(second.lineItems[0]!.pricingSource).toBe('uncatalogued');
  });

  // B7.5 — the catalog is the authority on unit of measure, and it was being
  // dropped here: a spoken "two gaskets" lost the fact that the catalog prices
  // them per each. The unit rides the same match that sets the price, so a
  // grounded line can never carry a unit from one item and a price from
  // another.
  it('a catalog match carries the item’s unit onto the grounded line', async () => {
    const grounded = await groundLineItemPricing(
      [{ description: 'gasket', quantity: 2 }],
      'unitPrice',
      loader,
    );
    expect(grounded.lineItems[0]!.pricingSource).toBe('catalog');
    expect(grounded.lineItems[0]!.unit).toBe('each');
    // Still idempotent with the unit attached.
    const again = await groundLineItemPricing(grounded.lineItems, 'unitPrice', loader);
    expect(again.lineItems).toEqual(grounded.lineItems);
  });

  it('an uncatalogued line gets no invented unit', async () => {
    const grounded = await groundLineItemPricing(
      [{ description: 'bespoke unicorn polish', quantity: 1, unitPrice: 9999 }],
      'unitPrice',
      loader,
    );
    expect(grounded.lineItems[0]!.pricingSource).toBe('uncatalogued');
    expect(grounded.lineItems[0]!.unit).toBeUndefined();
  });
});
