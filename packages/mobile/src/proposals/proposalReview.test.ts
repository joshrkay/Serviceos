import { describe, expect, it } from 'vitest';
import {
  UNDO_WINDOW_MS,
  ambiguousCatalogLines,
  entityCandidatesFromPayload,
  estimateTierView,
  formatCents,
  humanizeKey,
  reviewRows,
  typeLabel,
  undoSecondsLeft,
} from './proposalReview';

describe('typeLabel', () => {
  it('maps known types to friendly labels and de-underscores the rest', () => {
    expect(typeLabel('draft_invoice')).toBe('Invoice');
    expect(typeLabel('record_payment')).toBe('Payment');
    expect(typeLabel('some_new_type')).toBe('some new type');
  });

  it('gives the U5 money-in types real labels, not bare type strings', () => {
    expect(typeLabel('send_payment_reminder')).toBe('Payment reminder');
    expect(typeLabel('apply_late_fee')).toBe('Late fee');
    expect(typeLabel('send_estimate_nudge')).toBe('Estimate nudge');
  });
});

describe('estimateTierView — A5 good-better-best surfacing', () => {
  // Estimate proposal payloads carry the price in `unitPrice` (integer cents).
  it('groups tiers with per-tier totals in cents and marks the default', () => {
    const view = estimateTierView({
      lineItems: [
        { description: 'Basic', unitPrice: 500000, quantity: 1, groupKey: 'tier', groupLabel: 'Roof', isOptional: true },
        { description: 'Standard', unitPrice: 800000, quantity: 1, groupKey: 'tier', groupLabel: 'Roof', isOptional: true, isDefaultSelected: true },
        { description: 'Premium', unitPrice: 1200000, quantity: 1, groupKey: 'tier', groupLabel: 'Roof', isOptional: true },
      ],
    });
    expect(view.isTiered).toBe(true);
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0].label).toBe('Roof');
    expect(view.groups[0].options.map((o) => o.totalCents)).toEqual([500000, 800000, 1200000]);
    const def = view.groups[0].options.filter((o) => o.isDefault);
    expect(def).toHaveLength(1);
    expect(def[0].description).toBe('Standard');
  });

  it('multiplies unit price by quantity and reads unitPriceCents when present', () => {
    const view = estimateTierView({
      lineItems: [
        { description: 'A', unitPrice: 10000, quantity: 3, groupKey: 'g', groupLabel: 'Opts', isOptional: true },
        { description: 'B', unitPriceCents: 25000, quantity: 2, groupKey: 'g', groupLabel: 'Opts', isOptional: true, isDefaultSelected: true },
      ],
    });
    expect(view.groups[0].options.map((o) => o.totalCents)).toEqual([30000, 50000]);
  });

  it('separates standalone add-ons (isOptional, no groupKey)', () => {
    const view = estimateTierView({
      lineItems: [
        { description: 'Basic', unitPrice: 100, quantity: 1, groupKey: 'tier', groupLabel: 'Opts', isOptional: true, isDefaultSelected: true },
        { description: 'Better', unitPrice: 200, quantity: 1, groupKey: 'tier', groupLabel: 'Opts', isOptional: true },
        { description: 'Warranty', unitPrice: 5000, quantity: 1, isOptional: true },
      ],
    });
    expect(view.groups[0].options).toHaveLength(2);
    expect(view.addOns).toHaveLength(1);
    expect(view.addOns[0].description).toBe('Warranty');
    expect(view.addOns[0].totalCents).toBe(5000);
  });

  it('is not tiered for a flat single-tier estimate (no regression)', () => {
    const view = estimateTierView({
      lineItems: [
        { description: 'Labor', unitPrice: 5000, quantity: 2 },
        { description: 'Material', unitPrice: 3000, quantity: 1 },
      ],
    });
    expect(view.isTiered).toBe(false);
    expect(view.groups).toEqual([]);
    expect(view.addOns).toEqual([]);
  });

  it('degrades safely on malformed payloads', () => {
    expect(estimateTierView(undefined)).toEqual({ isTiered: false, groups: [], addOns: [] });
    expect(estimateTierView({})).toEqual({ isTiered: false, groups: [], addOns: [] });
    expect(estimateTierView({ lineItems: 'nope' })).toEqual({ isTiered: false, groups: [], addOns: [] });
    // Non-object rows / missing fields are skipped or defaulted, never thrown.
    const view = estimateTierView({
      lineItems: [null, 42, { groupKey: 'g', groupLabel: 'Opts', isOptional: true }, { groupKey: 'g', isOptional: true, unitPrice: 100 }],
    });
    expect(view.groups[0].options).toHaveLength(2);
    expect(view.groups[0].options[0].description).toBe('Line 3');
    expect(view.groups[0].options[0].totalCents).toBe(0);
  });
});

describe('reviewRows for U5 money-in proposals', () => {
  it('renders an apply_late_fee proposal with its recipient and fee amount', () => {
    // Payload shape from the apply_late_fee task handler
    // (packages/api/src/ai/tasks/voice-extended-tasks.ts): invoiceReference is
    // the resolved recipient, feeCents the money (rendered as dollars).
    const rows = reviewRows({ stepKey: 'manual', invoiceReference: 'Smith roof', feeCents: 2500 });
    expect(rows).toContainEqual({ label: 'Invoice Reference', value: 'Smith roof' });
    expect(rows).toContainEqual({ label: 'Fee Cents', value: '$25.00' });
  });

  it('renders a send_payment_reminder proposal with its recipient and channel, not a bare type', () => {
    const rows = reviewRows({ stepKey: 'manual', offsetDays: 0, channel: 'sms', invoiceReference: 'Acme Co' });
    expect(rows).toContainEqual({ label: 'Invoice Reference', value: 'Acme Co' });
    expect(rows).toContainEqual({ label: 'Channel', value: 'sms' });
  });
});

describe('humanizeKey', () => {
  it('turns camelCase and snake_case keys into Title Case', () => {
    expect(humanizeKey('customerName')).toBe('Customer Name');
    expect(humanizeKey('total_cents')).toBe('Total Cents');
    expect(humanizeKey('amountCents')).toBe('Amount Cents');
  });
});

describe('formatCents', () => {
  it('renders integer cents as dollars (no float math)', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(12345)).toBe('$123.45');
    expect(formatCents(-2000)).toBe('-$20.00');
  });
});

describe('reviewRows', () => {
  it('flattens top-level scalars, formats *Cents as dollars, skips nesting/null', () => {
    const rows = reviewRows({
      customerName: 'Acme',
      amountCents: 12345,
      sendCopy: true,
      lineItems: [{ x: 1 }], // nested → skipped
      note: null, // null → skipped
    });
    expect(rows).toEqual([
      { label: 'Customer Name', value: 'Acme' },
      { label: 'Amount Cents', value: '$123.45' },
      { label: 'Send Copy', value: 'Yes' },
    ]);
  });

  it('returns [] for an absent payload', () => {
    expect(reviewRows(undefined)).toEqual([]);
  });
});

describe('undoSecondsLeft', () => {
  const approvedAt = '2026-06-20T00:00:00.000Z';
  const t0 = Date.parse(approvedAt);

  it('counts whole seconds down from the 5s window', () => {
    expect(UNDO_WINDOW_MS).toBe(5000);
    expect(undoSecondsLeft(approvedAt, t0)).toBe(5);
    expect(undoSecondsLeft(approvedAt, t0 + 1)).toBe(5);
    expect(undoSecondsLeft(approvedAt, t0 + 1000)).toBe(4);
    expect(undoSecondsLeft(approvedAt, t0 + 4001)).toBe(1);
  });

  it('returns 0 at/after the window close and with no approval', () => {
    expect(undoSecondsLeft(approvedAt, t0 + 5000)).toBe(0);
    expect(undoSecondsLeft(approvedAt, t0 + 9999)).toBe(0);
    expect(undoSecondsLeft(null, t0)).toBe(0);
    expect(undoSecondsLeft(undefined, t0)).toBe(0);
  });
});

describe('entityCandidatesFromPayload', () => {
  it('maps entityCandidates into id/label/hint rows', () => {
    expect(
      entityCandidatesFromPayload({
        entityCandidates: [
          { id: 'c1', label: 'Bob Smith', hint: '555-0100', score: 0.9 },
          { id: 'c2', label: 'Bob Jones' },
        ],
      }),
    ).toEqual([
      { id: 'c1', label: 'Bob Smith', hint: '555-0100', score: 0.9 },
      { id: 'c2', label: 'Bob Jones', hint: undefined, score: undefined },
    ]);
  });

  it('returns [] when candidates are absent or malformed', () => {
    expect(entityCandidatesFromPayload(undefined)).toEqual([]);
    expect(entityCandidatesFromPayload({ entityCandidates: [{ bad: true }] })).toEqual([]);
  });
});

describe('ambiguousCatalogLines', () => {
  it('finds ambiguous lines with catalogResolution candidates', () => {
    expect(
      ambiguousCatalogLines(
        {
          lineItems: [
            { description: 'Flush valve', pricingSource: 'ambiguous' },
            { description: 'Labor', pricingSource: 'catalog' },
          ],
        },
        {
          catalogResolution: {
            '0': [{ id: 'cat-b', name: 'Premium valve', unitPriceCents: 8200, score: 0.6 }],
          },
        },
      ),
    ).toEqual([
      {
        lineIndex: 0,
        description: 'Flush valve',
        candidates: [{ id: 'cat-b', name: 'Premium valve', unitPriceCents: 8200, score: 0.6 }],
      },
    ]);
  });
});
