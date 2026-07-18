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
import { applyInvoiceEdits, InvoiceEditAction } from '../../../src/invoices/invoice-editor';
import { Invoice } from '../../../src/invoices/invoice';
import { decideInitialStatus } from '../../../src/proposals/proposal';
import {
  LineItem,
  PricingSource,
  calculateDocumentTotals,
  buildLineItem,
} from '../../../src/shared/billing-engine';

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

  it('surfaces a "did you mean" price conflict (≥10% AND ≥$1) instead of snapping — B3: two recorded candidates, resolvable gate', () => {
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
    // B3 split signal: a price conflict is RESOLVABLE — anyUncatalogued
    // (the sticky, never-lifted 'low' stamp) must stay false; the new
    // anyAmbiguousWithCandidates signal fires instead.
    expect(result.anyUncatalogued).toBe(false);
    expect(result.anyAmbiguousWithCandidates).toBe(true);
    expect(result.requiresReview).toBe(true);
    expect(result.markers[0].path).toBe('editActions[0].lineItem.unitPrice');
    expect(result.fieldConfidence['editActions[0].lineItem.unitPrice']).toBe('low');
    // B3 — one-tap candidates: the real catalog item + a synthetic "keep
    // spoken price" choice, mirroring the draft path's applyCatalogPricing.
    expect(result.missingFields).toEqual(['editActions[0].lineItem.catalogItemId']);
    expect(result.catalogResolution?.[0]).toEqual([
      { id: heater.id, name: heater.name, unitPriceCents: 15_000, score: 1, category: 'labor' },
      { id: 'spoken:0', name: 'Keep spoken price', unitPriceCents: 7_500, score: 0 },
    ]);
  });

  it('treats a zero drafted price as a real (comped) price → conflict, not a snap', () => {
    const { lineItems, result } = ground(
      [addAction({ description: 'water heater install', quantity: 1, unitPrice: 0 })],
      [heater],
    );
    expect(lineItems[0].unitPrice).toBe(0); // not overwritten to 15_000
    expect(lineItems[0].pricingSource).toBe('ambiguous');
    expect(result.anyUncatalogued).toBe(false);
    expect(result.anyAmbiguousWithCandidates).toBe(true);
    expect(result.missingFields).toEqual(['editActions[0].lineItem.catalogItemId']);
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

  it('flags an ambiguous match (multiple SKUs) as untrusted, never guessing a price — B3: candidates recorded, resolvable gate', () => {
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
    // B3 split signal: genuinely ambiguous (not "not in the catalog") — the
    // resolvable signal fires, the sticky uncatalogued signal does not.
    expect(result.anyUncatalogued).toBe(false);
    expect(result.anyAmbiguousWithCandidates).toBe(true);
    expect(result.missingFields).toEqual(['editActions[0].lineItem.catalogItemId']);
    // Candidates were computed by resolveLineItemToCatalog and previously
    // discarded — B3 records them for the one-tap picker.
    const candidates = result.catalogResolution?.[0] ?? [];
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.map((c) => c.name).sort()).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    expect(candidates.every((c) => typeof c.id === 'string' && typeof c.unitPriceCents === 'number')).toBe(
      true,
    );
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
    // Line 2 is genuinely not in the catalog → the sticky signal fires.
    expect(result.anyUncatalogued).toBe(true);
    // Line 1 is a resolvable price conflict → the resolvable signal ALSO
    // fires, independent of line 2's uncatalogued signal.
    expect(result.anyAmbiguousWithCandidates).toBe(true);
    expect(result.requiresReview).toBe(true);
    // Only the resolvable line (1) gets a missingFields gate + candidates —
    // line 2 has nothing to resolve to.
    expect(result.missingFields).toEqual(['editActions[1].lineItem.catalogItemId']);
    expect(result.catalogResolution?.[1]).toBeDefined();
    expect(result.catalogResolution?.[2]).toBeUndefined();
    // One marker per untrusted line, at the right indices.
    expect(result.markers.map((m) => m.path)).toEqual([
      'editActions[1].lineItem.unitPrice',
      'editActions[2].lineItem.unitPrice',
    ]);
  });

  // Parity with the old per-task `groundEditActionPricing` (deleted on this
  // branch — recovered from git history at 6cc376a^ in
  // ai/tasks/invoice-edit-task.ts / estimate-edit-task.ts), which routed
  // through `resolveSpokenLineItems` (ai/tasks/catalog-resolution.ts). That
  // resolver defaults quantity to 1 ONLY on its `resolved` (single
  // catalog-candidate) branch — unresolved/no-match items are pushed
  // through with whatever quantity (or lack of one) the LLM gave.
  describe('quantity defaulting parity (old resolveSpokenLineItems behavior)', () => {
    it('defaults a catalog-matched line with omitted quantity to 1 ("add a trip fee")', () => {
      const { lineItems } = ground(
        [addAction({ description: 'water heater install', unitPrice: 15_000 })],
        [heater],
      );
      expect(lineItems[0].pricingSource).toBe('catalog');
      expect(lineItems[0].quantity).toBe(1);
    });

    it('defaults a catalog-matched line with an invalid quantity (0/negative/non-number) to 1', () => {
      for (const bad of [0, -1, 'two', null, undefined]) {
        const { lineItems } = ground(
          [addAction({ description: 'water heater install', quantity: bad, unitPrice: 15_000 })],
          [heater],
        );
        expect(lineItems[0].pricingSource).toBe('catalog');
        expect(lineItems[0].quantity).toBe(1);
      }
    });

    it('keeps an explicit valid quantity on a catalog-matched line', () => {
      const { lineItems } = ground(
        [addAction({ description: 'water heater install', quantity: 3, unitPrice: 15_000 })],
        [heater],
      );
      expect(lineItems[0].pricingSource).toBe('catalog');
      expect(lineItems[0].quantity).toBe(3);
    });

    it('does NOT default quantity for an uncatalogued line with omitted quantity — old resolver left unresolved items untouched', () => {
      const { lineItems } = ground(
        [addAction({ description: 'premium widget', unitPrice: 12_345 })],
        [heater],
      );
      expect(lineItems[0].pricingSource).toBe('uncatalogued');
      expect(lineItems[0].quantity).toBeUndefined();
    });

    it('does NOT default quantity for an ambiguous ("did you mean") line with omitted quantity', () => {
      const { lineItems } = ground(
        [addAction({ description: 'water heater install', unitPrice: 7_500 })],
        [heater],
      );
      expect(lineItems[0].pricingSource).toBe('ambiguous');
      expect(lineItems[0].quantity).toBeUndefined();
    });
  });

  // B3 — the split review signal must not weaken the approval gate: a
  // resolvable ambiguity (anyAmbiguousWithCandidates) does NOT drive the
  // sticky `_meta.overallConfidence:'low'` stamp, so this proves the
  // ACTUAL blocker independently — missingFields alone, via
  // decideInitialStatus (proposals/proposal.ts), which is what
  // approveProposal / createProposal consult.
  describe('B3 — an ambiguous-only edit action cannot auto-approve', () => {
    it('a price-conflict-only edit action (never anyUncatalogued) still forces draft via missingFields at high confidence', () => {
      const { result } = ground(
        [addAction({ description: 'water heater install', quantity: 1, unitPrice: 7_500 })],
        [heater],
      );
      // Precondition: this line is resolvable, NOT the sticky-low path.
      expect(result.anyUncatalogued).toBe(false);
      expect(result.anyAmbiguousWithCandidates).toBe(true);
      expect(result.missingFields.length).toBeGreaterThan(0);

      const status = decideInitialStatus({
        proposalType: 'update_invoice',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.99, // would auto-approve on its own
        missingFields: result.missingFields,
        // Deliberately no payload._meta stamp — proves missingFields ALONE
        // blocks, independent of the (here absent) confidence marker.
      });
      expect(status).toBe('draft');
    });

    it('a purely-ambiguous (multi-SKU) edit action also forces draft via missingFields at high confidence', () => {
      const ball = item('Ball Valve', 3_200);
      const gate = item('Gate Valve', 4_100);
      const check = item('Check Valve', 3_900);
      const { result } = ground(
        [addAction({ description: 'valve', quantity: 1, unitPrice: 3_500 })],
        [ball, gate, check],
      );
      expect(result.anyUncatalogued).toBe(false);
      expect(result.missingFields.length).toBeGreaterThan(0);

      const status = decideInitialStatus({
        proposalType: 'update_estimate',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.99,
        missingFields: result.missingFields,
      });
      expect(status).toBe('draft');
    });
  });

  describe('end-to-end: a grounded catalog-matched add with omitted quantity survives applyInvoiceEdits validation', () => {
    function makeInvoice(): Invoice {
      const lineItems: LineItem[] = [
        buildLineItem('li-1', 'Diagnostic visit', 1, 12500, 0, true, 'labor'),
      ];
      const totals = calculateDocumentTotals(lineItems, 0, 0);
      return {
        id: 'inv-1',
        tenantId: TENANT,
        jobId: 'job-1',
        invoiceNumber: 'INV-0001',
        status: 'draft',
        lineItems,
        totals,
        amountPaidCents: 0,
        amountDueCents: totals.totalCents,
        createdBy: 'u-1',
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      };
    }

    it('a voice "add a trip fee" edit action (LLM omits quantity) applies cleanly once grounded', () => {
      // Simulate the LLM output for "add a trip fee" — no quantity field at all.
      const { result } = ground(
        [addAction({ description: 'water heater install', unitPrice: 15_000 })],
        [heater],
      );
      const groundedLineItem = (
        result.payload.editActions as Array<Record<string, unknown>>
      )[0].lineItem as Record<string, unknown>;
      expect(groundedLineItem.quantity).toBe(1); // pre-condition: grounding defaulted it

      const action: InvoiceEditAction = {
        type: 'add_line_item',
        lineItem: {
          description: groundedLineItem.description as string,
          quantity: groundedLineItem.quantity as number,
          unitPrice: groundedLineItem.unitPrice as number,
          pricingSource: groundedLineItem.pricingSource as PricingSource,
        },
      };

      const { updatedInvoice } = applyInvoiceEdits(makeInvoice(), [action]);
      expect(updatedInvoice.lineItems).toHaveLength(2);
      expect(updatedInvoice.lineItems[1].quantity).toBe(1);
      expect(updatedInvoice.lineItems[1].totalCents).toBe(15_000);
    });
  });
});
