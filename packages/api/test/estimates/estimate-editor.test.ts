/**
 * estimate-editor unit tests (entity editor).
 *
 * NOT the same as proposals/estimate-editor.ts — that one edits
 * draft_estimate Proposal payloads before execution. This one edits
 * an existing Estimate ENTITY after it's been created.
 *
 * Mirrors the Phase-2 invoice-editor pattern:
 *   - Only editable in draft / ready_for_review status
 *   - Recomputes totals via billing-engine after every edit
 *   - Immutable — input never mutated
 *   - Rejects invalid indices and invalid line items
 */
import { describe, it, expect } from 'vitest';
import {
  applyEstimateEdits,
  EstimateEditAction,
  EstimateEditLineItemInput,
} from '../../src/estimates/estimate-editor';
import { Estimate } from '../../src/estimates/estimate';
import { LineItem, buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import { ValidationError } from '../../src/shared/errors';

function makeEstimate(overrides: Partial<Estimate> = {}): Estimate {
  const lineItems: LineItem[] = [
    buildLineItem('li-1', 'Site visit', 1, 15000, 0, true, 'labor'),
    buildLineItem('li-2', '50-gallon heater', 1, 85000, 1, true, 'material'),
  ];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: 'est-1',
    tenantId: 't-1',
    jobId: 'job-1',
    estimateNumber: 'EST-0001',
    status: 'draft',
    lineItems,
    totals,
    createdBy: 'u-1',
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  };
}

describe('applyEstimateEdits — add_line_item', () => {
  it('appends a new line item and recomputes totals', () => {
    const estimate = makeEstimate();
    const action: EstimateEditAction = {
      type: 'add_line_item',
      lineItem: {
        description: 'Disposal fee',
        quantity: 1,
        unitPrice: 7500,
        category: 'other',
      } satisfies EstimateEditLineItemInput,
    };

    const { updatedEstimate, editedFields } = applyEstimateEdits(estimate, [action]);

    expect(updatedEstimate.lineItems).toHaveLength(3);
    expect(updatedEstimate.lineItems[2].description).toBe('Disposal fee');
    expect(updatedEstimate.lineItems[2].totalCents).toBe(7500);
    expect(updatedEstimate.lineItems[2].sortOrder).toBe(2);
    expect(updatedEstimate.totals.subtotalCents).toBe(15000 + 85000 + 7500);
    expect(editedFields).toContain('lineItems[2]');
    expect(estimate.lineItems).toHaveLength(2);
  });

  it('rejects negative unit price', () => {
    const estimate = makeEstimate();
    expect(() =>
      applyEstimateEdits(estimate, [
        { type: 'add_line_item', lineItem: { description: 'bad', quantity: 1, unitPrice: -50 } },
      ])
    ).toThrow(ValidationError);
  });

  it('rejects missing description', () => {
    const estimate = makeEstimate();
    expect(() =>
      applyEstimateEdits(estimate, [
        { type: 'add_line_item', lineItem: { description: '', quantity: 1, unitPrice: 100 } },
      ])
    ).toThrow(ValidationError);
  });
});

describe('applyEstimateEdits — remove_line_item', () => {
  it('removes the target and recomputes totals', () => {
    const estimate = makeEstimate();
    const { updatedEstimate } = applyEstimateEdits(estimate, [
      { type: 'remove_line_item', index: 0 },
    ]);
    expect(updatedEstimate.lineItems).toHaveLength(1);
    expect(updatedEstimate.lineItems[0].description).toBe('50-gallon heater');
    expect(updatedEstimate.totals.subtotalCents).toBe(85000);
  });

  it('rejects negative index', () => {
    expect(() =>
      applyEstimateEdits(makeEstimate(), [{ type: 'remove_line_item', index: -1 }])
    ).toThrow(ValidationError);
  });

  it('rejects out-of-range index', () => {
    expect(() =>
      applyEstimateEdits(makeEstimate(), [{ type: 'remove_line_item', index: 99 }])
    ).toThrow(ValidationError);
  });
});

// P1 data-corruption regression — mirrors invoices/invoice-editor.ts
// exactly. The LLM edit-task prompt (ai/tasks/estimate-edit-task.ts) has
// always emitted description-based remove_line_item/update_line_item
// actions with NO numeric index. The old range guard
// (`index < 0 || index >= length`) let `undefined` through both
// comparisons, so `lineItems.splice(undefined, 1)` silently coerced to
// `splice(0, 1)` — deleting the FIRST line item instead of the one the
// operator named.
describe('applyEstimateEdits — index-or-description resolution', () => {
  it('CORRUPTION REGRESSION: an undefined index throws instead of silently removing the first line item', () => {
    const estimate = makeEstimate();
    expect(() =>
      applyEstimateEdits(estimate, [{ type: 'remove_line_item', index: undefined as unknown as number }])
    ).toThrow(ValidationError);
    expect(estimate.lineItems).toHaveLength(2);
    expect(estimate.lineItems[0].description).toBe('Site visit');
    expect(estimate.lineItems[1].description).toBe('50-gallon heater');
  });

  it('CORRUPTION REGRESSION: a non-integer index (NaN) throws instead of coercing', () => {
    const estimate = makeEstimate();
    expect(() =>
      applyEstimateEdits(estimate, [{ type: 'remove_line_item', index: NaN }])
    ).toThrow(ValidationError);
    expect(estimate.lineItems).toHaveLength(2);
  });

  it('CORRUPTION REGRESSION: a float index throws instead of truncating', () => {
    const estimate = makeEstimate();
    expect(() =>
      applyEstimateEdits(estimate, [
        { type: 'update_line_item', index: 0.5, lineItem: { description: 'x', quantity: 1, unitPrice: 100 } },
      ])
    ).toThrow(ValidationError);
    expect(estimate.lineItems).toHaveLength(2);
  });

  it('remove_line_item with neither index nor description throws a clear error, not a silent first-item removal', () => {
    const estimate = makeEstimate();
    expect(() =>
      applyEstimateEdits(estimate, [{ type: 'remove_line_item' } as EstimateEditAction])
    ).toThrow(/numeric index or a description/i);
    expect(estimate.lineItems).toHaveLength(2);
  });

  it('description resolves to the unique matching line item (remove)', () => {
    const estimate = makeEstimate();
    const { updatedEstimate } = applyEstimateEdits(estimate, [
      { type: 'remove_line_item', description: 'Site visit' },
    ]);
    expect(updatedEstimate.lineItems).toHaveLength(1);
    expect(updatedEstimate.lineItems[0].description).toBe('50-gallon heater');
  });

  it('description resolves case-insensitively and via substring match (remove)', () => {
    const estimate = makeEstimate();
    const { updatedEstimate } = applyEstimateEdits(estimate, [
      { type: 'remove_line_item', description: 'site' },
    ]);
    expect(updatedEstimate.lineItems).toHaveLength(1);
    expect(updatedEstimate.lineItems[0].description).toBe('50-gallon heater');
  });

  it('description resolves to the unique matching line item (update)', () => {
    const estimate = makeEstimate();
    const originalId = estimate.lineItems[0].id;
    const { updatedEstimate } = applyEstimateEdits(estimate, [
      {
        type: 'update_line_item',
        description: 'site visit',
        lineItem: { description: 'Extended site visit', quantity: 1, unitPrice: 20000, category: 'labor' },
      },
    ]);
    expect(updatedEstimate.lineItems[0].id).toBe(originalId);
    expect(updatedEstimate.lineItems[0].description).toBe('Extended site visit');
    expect(updatedEstimate.lineItems[1].description).toBe('50-gallon heater');
  });

  it('description with zero matches throws a clear "no line item matching" error', () => {
    const estimate = makeEstimate();
    expect(() =>
      applyEstimateEdits(estimate, [{ type: 'remove_line_item', description: 'nonexistent widget' }])
    ).toThrow(/no line item matching/i);
    expect(estimate.lineItems).toHaveLength(2);
  });

  it('description with 2+ matches throws an ambiguity error instead of guessing', () => {
    const estimate = makeEstimate({
      lineItems: [
        buildLineItem('li-1', 'Filter A', 1, 1000, 0, true, 'material'),
        buildLineItem('li-2', 'Filter B', 1, 2000, 1, true, 'material'),
      ],
    });
    expect(() =>
      applyEstimateEdits(estimate, [{ type: 'remove_line_item', description: 'Filter' }])
    ).toThrow(/matches 2 line items/i);
    expect(estimate.lineItems).toHaveLength(2);
  });

  it('numeric index still works (backward compat) even though description is now also supported', () => {
    const estimate = makeEstimate();
    const { updatedEstimate } = applyEstimateEdits(estimate, [
      { type: 'remove_line_item', index: 0 },
    ]);
    expect(updatedEstimate.lineItems).toHaveLength(1);
    expect(updatedEstimate.lineItems[0].description).toBe('50-gallon heater');
  });
});

describe('applyEstimateEdits — update_line_item', () => {
  it('replaces a line item and keeps its id', () => {
    const estimate = makeEstimate();
    const originalId = estimate.lineItems[1].id;

    const { updatedEstimate } = applyEstimateEdits(estimate, [
      {
        type: 'update_line_item',
        index: 1,
        lineItem: { description: 'Tankless heater', quantity: 1, unitPrice: 145000, category: 'material' },
      },
    ]);

    expect(updatedEstimate.lineItems[1].id).toBe(originalId);
    expect(updatedEstimate.lineItems[1].description).toBe('Tankless heater');
    expect(updatedEstimate.lineItems[1].totalCents).toBe(145000);
    expect(updatedEstimate.totals.subtotalCents).toBe(15000 + 145000);
  });
});

describe('applyEstimateEdits — chaining', () => {
  it('applies multiple edits in order', () => {
    const estimate = makeEstimate();
    const { updatedEstimate } = applyEstimateEdits(estimate, [
      { type: 'remove_line_item', index: 1 },
      {
        type: 'add_line_item',
        lineItem: { description: 'Tankless heater', quantity: 1, unitPrice: 145000 },
      },
    ]);
    expect(updatedEstimate.lineItems.map((l) => l.description)).toEqual([
      'Site visit',
      'Tankless heater',
    ]);
    expect(updatedEstimate.totals.subtotalCents).toBe(15000 + 145000);
  });
});

describe('applyEstimateEdits — status guard', () => {
  it('allows edits on draft', () => {
    const estimate = makeEstimate({ status: 'draft' });
    expect(() =>
      applyEstimateEdits(estimate, [{ type: 'remove_line_item', index: 0 }])
    ).not.toThrow();
  });

  it('allows edits on ready_for_review', () => {
    const estimate = makeEstimate({ status: 'ready_for_review' });
    expect(() =>
      applyEstimateEdits(estimate, [{ type: 'remove_line_item', index: 0 }])
    ).not.toThrow();
  });

  it('refuses to edit a sent estimate', () => {
    const estimate = makeEstimate({ status: 'sent' });
    expect(() =>
      applyEstimateEdits(estimate, [
        { type: 'add_line_item', lineItem: { description: 'x', quantity: 1, unitPrice: 100 } },
      ])
    ).toThrow(/sent|editable|draft/i);
  });

  it('refuses to edit an accepted estimate', () => {
    const estimate = makeEstimate({ status: 'accepted' });
    expect(() =>
      applyEstimateEdits(estimate, [{ type: 'remove_line_item', index: 0 }])
    ).toThrow(/accepted|editable|draft/i);
  });
});

describe('applyEstimateEdits — empty actions', () => {
  it('rejects an empty action list', () => {
    expect(() => applyEstimateEdits(makeEstimate(), [])).toThrow(/at least one/i);
  });
});

describe('applyEstimateEdits — pricingSource provenance', () => {
  it('carries pricingSource through add_line_item when the grounder stamped one', () => {
    const estimate = makeEstimate();
    const { updatedEstimate } = applyEstimateEdits(estimate, [
      {
        type: 'add_line_item',
        lineItem: {
          description: 'Catalog-grounded part',
          quantity: 1,
          unitPrice: 4200,
          category: 'material',
          pricingSource: 'catalog',
        } satisfies EstimateEditLineItemInput,
      },
    ]);

    expect(updatedEstimate.lineItems[2].pricingSource).toBe('catalog');
  });

  it('carries pricingSource through update_line_item when the grounder stamped one', () => {
    const estimate = makeEstimate();
    const { updatedEstimate } = applyEstimateEdits(estimate, [
      {
        type: 'update_line_item',
        index: 1,
        lineItem: {
          description: 'Tankless heater',
          quantity: 1,
          unitPrice: 145000,
          category: 'material',
          pricingSource: 'ambiguous',
        } satisfies EstimateEditLineItemInput,
      },
    ]);

    expect(updatedEstimate.lineItems[1].pricingSource).toBe('ambiguous');
  });

  it('leaves pricingSource undefined when the action carries no grounding signal', () => {
    const estimate = makeEstimate();
    const { updatedEstimate } = applyEstimateEdits(estimate, [
      {
        type: 'add_line_item',
        lineItem: {
          description: 'Manually entered line',
          quantity: 1,
          unitPrice: 1000,
        } satisfies EstimateEditLineItemInput,
      },
    ]);

    expect(updatedEstimate.lineItems[2].pricingSource).toBeUndefined();
  });
});
