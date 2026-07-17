/**
 * Unit tests for the shared edit-action catalog grounding
 * (ai/resolution/edit-action-grounding.ts) — the single grounding pass
 * behind the update_estimate / update_invoice task handlers. Verifies the
 * SAME money-correctness contract as the draft path, on the edit-action
 * shape: catalog snap, "did you mean" price conflict, uncatalogued,
 * ambiguous, and no-catalog — plus the executable/mirror price-field
 * split (`unitPrice` executable + `unitPriceCents` mirror for BOTH
 * document types on the edit path).
 */
import { describe, it, expect } from 'vitest';
import { CatalogItem, createCatalogItem } from '../../../src/catalog/catalog-item';
import { groundEditActionPricing } from '../../../src/ai/resolution/edit-action-grounding';

const TENANT = 'tenant-1';

function item(
  name: string,
  unitPriceCents: number,
  overrides: Partial<Parameters<typeof createCatalogItem>[0]> = {},
): CatalogItem {
  return createCatalogItem({
    tenantId: TENANT,
    name,
    category: 'Labor',
    unit: 'each',
    unitPriceCents,
    ...overrides,
  });
}

function addAction(lineItem: Record<string, unknown>) {
  return { type: 'add_line_item', lineItem };
}

function ground(actions: Array<Record<string, unknown>>, catalog: CatalogItem[]) {
  const result = groundEditActionPricing({ editActions: actions }, catalog);
  const lineItems = (result.payload.editActions as Array<Record<string, unknown>>).map(
    (a) => a.lineItem as Record<string, unknown>,
  );
  return { result, lineItems };
}

describe('groundEditActionPricing', () => {
  const heater = item('Water Heater Install', 15_000);

  it('snaps a sub-tolerance mishear to the catalog price on BOTH price fields', () => {
    const { result, lineItems } = ground(
      // 14_950 is within PRICE_CONFLICT_MIN_ABS_CENTS (100¢) of 15_000 → snap.
      [addAction({ description: 'water heater install', quantity: 1, unitPrice: 14_950 })],
      [heater],
    );
    expect(lineItems[0]).toMatchObject({
      description: 'Water Heater Install',
      unitPrice: 15_000, // executable field the editors read
      unitPriceCents: 15_000, // review mirror
      catalogItemId: heater.id,
      category: 'labor',
      pricingSource: 'catalog',
      needsPricing: false,
    });
    expect(result.anyCatalogPriced).toBe(true);
    expect(result.anyUncatalogued).toBe(false);
    expect(result.requiresReview).toBe(false);
    expect(result.markers).toHaveLength(0);
  });

  it('surfaces a "did you mean" price conflict (≥10% AND ≥$1) instead of snapping', () => {
    const { result, lineItems } = ground(
      // 7_500 deviates from 15_000 by 50% and $75 — a conflict, not a mishear.
      [addAction({ description: 'water heater install', quantity: 1, unitPrice: 7_500 })],
      [heater],
    );
    // Spoken price KEPT on the executable field, mirror nulled, flagged.
    expect(lineItems[0].unitPrice).toBe(7_500);
    expect(lineItems[0].unitPriceCents).toBeNull();
    expect(lineItems[0].pricingSource).toBe('ambiguous');
    expect(lineItems[0].needsPricing).toBe(true);
    expect(lineItems[0]).not.toHaveProperty('catalogItemId');
    expect(result.anyCatalogPriced).toBe(false);
    expect(result.anyUncatalogued).toBe(true);
    expect(result.requiresReview).toBe(true);
    expect(result.markers[0].path).toBe('editActions[0].lineItem.unitPrice');
    expect(result.fieldConfidence['editActions[0].lineItem.unitPrice']).toBe('low');
  });

  it('treats a zero drafted price as a real (comped) price → conflict, not a snap', () => {
    const { lineItems, result } = ground(
      [addAction({ description: 'water heater install', quantity: 1, unitPrice: 0 })],
      [heater],
    );
    expect(lineItems[0].unitPrice).toBe(0); // not overwritten to 15_000
    expect(lineItems[0].pricingSource).toBe('ambiguous');
    expect(result.anyUncatalogued).toBe(true);
  });

  it('flags an uncatalogued line (not in catalog) — spoken price kept, mirror nulled', () => {
    const { result, lineItems } = ground(
      [addAction({ description: 'premium widget', quantity: 1, unitPrice: 12_345 })],
      [heater],
    );
    expect(lineItems[0].unitPrice).toBe(12_345);
    expect(lineItems[0].unitPriceCents).toBeNull();
    expect(lineItems[0].pricingSource).toBe('uncatalogued');
    expect(lineItems[0].needsPricing).toBe(true);
    expect(result.anyUncatalogued).toBe(true);
    expect(result.requiresReview).toBe(true);
  });

  it('flags an ambiguous match (multiple SKUs) as untrusted, never guessing a price', () => {
    const ball = item('Ball Valve', 3_200);
    const gate = item('Gate Valve', 4_100);
    const check = item('Check Valve', 3_900);
    const { result, lineItems } = ground(
      [addAction({ description: 'valve', quantity: 1, unitPrice: 3_500 })],
      [ball, gate, check],
    );
    expect(lineItems[0].unitPrice).toBe(3_500);
    expect(lineItems[0].unitPriceCents).toBeNull();
    expect(lineItems[0].pricingSource).toBe('ambiguous');
    expect(lineItems[0].needsPricing).toBe(true);
    expect(lineItems[0].description).toBe('valve'); // LLM text kept verbatim
    expect(result.anyUncatalogued).toBe(true);
  });

  it('treats an EMPTY catalog as "no catalog to ground against" → every priced line uncatalogued', () => {
    const { result, lineItems } = ground(
      [addAction({ description: 'trip fee', quantity: 1, unitPrice: 7_500 })],
      [],
    );
    expect(lineItems[0].unitPrice).toBe(7_500);
    expect(lineItems[0].unitPriceCents).toBeNull();
    expect(lineItems[0].pricingSource).toBe('uncatalogued');
    expect(result.anyUncatalogued).toBe(true);
    expect(result.anyCatalogPriced).toBe(false);
  });

  it('passes remove_line_item and malformed actions through untouched', () => {
    const { result } = ground(
      [
        { type: 'remove_line_item', description: 'disposal fee' } as Record<string, unknown>,
        addAction({ description: 'water heater install', quantity: 1, unitPrice: 15_000 }),
      ],
      [heater],
    );
    const actions = result.payload.editActions as Array<Record<string, unknown>>;
    expect(actions[0]).toEqual({ type: 'remove_line_item', description: 'disposal fee' });
    expect((actions[1].lineItem as Record<string, unknown>).pricingSource).toBe('catalog');
  });

  it('grounds update_line_item the same as add_line_item', () => {
    const result = groundEditActionPricing(
      {
        editActions: [
          { type: 'update_line_item', index: 0, lineItem: { description: 'premium widget', quantity: 1, unitPrice: 999 } },
        ],
      },
      [heater],
    );
    const li = (result.payload.editActions as Array<Record<string, unknown>>)[0].lineItem as Record<string, unknown>;
    expect(li.pricingSource).toBe('uncatalogued');
    expect(li.unitPriceCents).toBeNull();
    expect(result.anyUncatalogued).toBe(true);
  });

  it('returns the payload untouched when editActions is not an array', () => {
    const payload = { editActions: 'nope' } as unknown as Record<string, unknown>;
    const result = groundEditActionPricing(payload, [heater]);
    expect(result.payload).toBe(payload);
    expect(result.anyUncatalogued).toBe(false);
    expect(result.anyCatalogPriced).toBe(false);
    expect(result.requiresReview).toBe(false);
  });

  it('mixed batch: catalog snap + conflict + uncatalogued → requiresReview and correct per-line flags', () => {
    const { result, lineItems } = ground(
      [
        addAction({ description: 'water heater install', quantity: 1, unitPrice: 15_000 }), // clean
        addAction({ description: 'water heater install', quantity: 1, unitPrice: 100 }), // conflict
        addAction({ description: 'mystery thing', quantity: 1, unitPrice: 4_200 }), // uncatalogued
      ],
      [heater],
    );
    expect(lineItems[0].pricingSource).toBe('catalog');
    expect(lineItems[1].pricingSource).toBe('ambiguous');
    expect(lineItems[2].pricingSource).toBe('uncatalogued');
    expect(result.anyCatalogPriced).toBe(true);
    expect(result.anyUncatalogued).toBe(true);
    expect(result.requiresReview).toBe(true);
    // One marker per untrusted line, at the right indices.
    expect(result.markers.map((m) => m.path)).toEqual([
      'editActions[1].lineItem.unitPrice',
      'editActions[2].lineItem.unitPrice',
    ]);
  });
});
