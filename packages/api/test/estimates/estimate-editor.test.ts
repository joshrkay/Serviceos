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
