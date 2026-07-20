import { describe, expect, it } from 'vitest';
import {
  UNDO_WINDOW_MS,
  agreementProposalView,
  ambiguousCatalogLines,
  callbackView,
  complaintNoteView,
  entityCandidatesFromPayload,
  estimateTierView,
  formatCents,
  humanizeKey,
  proposalMarkerReasons,
  reviewResponseView,
  reviewRows,
  type ReviewProposal,
  typeLabel,
  undoSecondsLeft,
} from './proposalReview';

/** Minimal ReviewProposal factory for the render-helper tests. */
function makeProposal(over: Partial<ReviewProposal>): ReviewProposal {
  return {
    id: 'p1',
    proposalType: 'callback',
    status: 'ready_for_review',
    summary: '',
    ...over,
  };
}

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

describe('proposalMarkerReasons', () => {
  it('extracts marker reasons from _meta.markers', () => {
    expect(
      proposalMarkerReasons({ _meta: { markers: [{ path: 'body', reason: 'complaint_high_severity' }] } }),
    ).toEqual(['complaint_high_severity']);
  });

  it('is malformed-safe (no _meta, non-array markers, missing reason)', () => {
    expect(proposalMarkerReasons(undefined)).toEqual([]);
    expect(proposalMarkerReasons({})).toEqual([]);
    expect(proposalMarkerReasons({ _meta: { markers: 'nope' } })).toEqual([]);
    expect(proposalMarkerReasons({ _meta: { markers: [{ path: 'x' }, 7] } })).toEqual([]);
  });
});

describe('complaintNoteView (C7)', () => {
  it('surfaces the pinned [COMPLAINT] marker, normal severity, and the cleaned body', () => {
    const view = complaintNoteView(
      makeProposal({
        proposalType: 'add_note',
        payload: { body: '[COMPLAINT] Tech left the yard gate open', targetKind: 'customer', targetId: 'c1' },
      }),
    );
    expect(view).toEqual({ pinned: true, severity: 'normal', body: 'Tech left the yard gate open' });
  });

  it('reads high severity from the _meta.markers flag', () => {
    const view = complaintNoteView(
      makeProposal({
        proposalType: 'add_note',
        payload: {
          body: '[COMPLAINT] Wants a full refund and is calling a lawyer',
          _meta: { markers: [{ path: 'body', reason: 'complaint_high_severity' }] },
        },
      }),
    );
    expect(view?.severity).toBe('high');
    expect(view?.body).toBe('Wants a full refund and is calling a lawyer');
  });

  it('returns null for a non-complaint add_note and for non-add_note types', () => {
    expect(complaintNoteView(makeProposal({ proposalType: 'add_note', payload: { body: 'Regular note' } }))).toBeNull();
    expect(complaintNoteView(makeProposal({ proposalType: 'callback', payload: { body: '[COMPLAINT] x' } }))).toBeNull();
    expect(complaintNoteView(makeProposal({ proposalType: 'add_note', payload: {} }))).toBeNull();
    expect(complaintNoteView(undefined)).toBeNull();
  });
});

describe('callbackView (C7/C8)', () => {
  it('frames a complaint follow-up callback and escalates severity', () => {
    const normal = callbackView(
      makeProposal({ proposalType: 'callback', payload: { reason: 'customer_complaint_followup' } }),
    );
    expect(normal?.kind).toBe('complaint');
    expect(normal?.severity).toBe('normal');
    expect(normal?.framing).toMatch(/Complaint follow-up/);

    const high = callbackView(
      makeProposal({
        proposalType: 'callback',
        payload: {
          reason: 'customer_complaint_followup',
          _meta: { markers: [{ path: 'body', reason: 'complaint_high_severity' }] },
        },
      }),
    );
    expect(high?.severity).toBe('high');
    expect(high?.framing).toMatch(/High-severity/);
  });

  it('frames a negotiation callback as the AI having NOT conceded, with the ask + recommendation', () => {
    const view = callbackView(
      makeProposal({
        proposalType: 'callback',
        payload: {
          reason: 'customer_negotiation_followup',
          negotiationAskType: 'discount',
          askText: 'Can you knock off 10%?',
          recommendation: 'Hold your price; offer a faster slot instead.',
          _meta: { markers: [{ path: 'recommendation', reason: 'negotiation_guardrail' }] },
        },
      }),
    );
    expect(view?.kind).toBe('negotiation');
    expect(view?.framing).toMatch(/did NOT negotiate or concede/);
    expect(view?.askText).toBe('Can you knock off 10%?');
    expect(view?.recommendation).toBe('Hold your price; offer a faster slot instead.');
  });

  it('distinguishes a discount-within-policy ALLOW callback', () => {
    const view = callbackView(
      makeProposal({
        proposalType: 'callback',
        payload: {
          reason: 'customer_negotiation_followup',
          _meta: { markers: [{ path: 'recommendation', reason: 'negotiation_discount_within_policy' }] },
        },
      }),
    );
    expect(view?.kind).toBe('discount_within_policy');
    expect(view?.framing).toMatch(/did NOT apply it/);
  });

  it('surfaces a tap-to-call customerId from the payload, the record target, or sourceContext', () => {
    expect(
      callbackView(makeProposal({ payload: { reason: 'customer_complaint_followup', customerId: 'c1' } }))?.customerId,
    ).toBe('c1');
    expect(
      callbackView(
        makeProposal({ payload: { reason: 'customer_complaint_followup' }, targetEntityType: 'customer', targetEntityId: 'c2' }),
      )?.customerId,
    ).toBe('c2');
    expect(
      callbackView(makeProposal({ payload: { reason: 'customer_complaint_followup' }, sourceContext: { customerId: 'c3' } }))
        ?.customerId,
    ).toBe('c3');
    // Today's real complaint/negotiation callback payloads carry no customer id.
    expect(callbackView(makeProposal({ payload: { reason: 'customer_complaint_followup' } }))?.customerId).toBeUndefined();
  });

  it('is malformed-safe and returns null for non-callback types', () => {
    expect(callbackView(makeProposal({ proposalType: 'draft_invoice', payload: { reason: 'x' } }))).toBeNull();
    expect(callbackView(makeProposal({ proposalType: 'callback', payload: undefined }))?.kind).toBe('generic');
    expect(callbackView(undefined)).toBeNull();
  });
});

describe('reviewResponseView (E9)', () => {
  it('surfaces the drafted public reply text prominently', () => {
    const view = reviewResponseView(
      makeProposal({
        proposalType: 'review_response_proposal',
        payload: {
          reviewId: 'r1',
          classification: 'specific_complaint',
          publicResponse: { text: 'Thank you for the feedback — we will make it right.', approved: false },
          privateFollowUp: null,
          serviceCredit: null,
        },
      }),
    );
    expect(view?.publicReply).toBe('Thank you for the feedback — we will make it right.');
    expect(view?.classification).toBe('specific_complaint');
    expect(view?.privateFollowUp).toBeUndefined();
    expect(view?.serviceCreditCents).toBeUndefined();
  });

  it('carries the private follow-up and service credit when present', () => {
    const view = reviewResponseView(
      makeProposal({
        proposalType: 'review_response_proposal',
        payload: {
          reviewId: 'r1',
          publicResponse: { text: 'Public reply.', approved: false },
          privateFollowUp: { customerId: 'c1', channel: 'sms', body: 'Sorry about that!', approved: false },
          serviceCredit: { customerId: 'c1', amountCents: 2500, approved: false },
        },
      }),
    );
    expect(view?.privateFollowUp).toEqual({ channel: 'sms', body: 'Sorry about that!' });
    expect(view?.serviceCreditCents).toBe(2500);
  });

  it('is malformed-safe and returns null for other types / empty reply', () => {
    expect(reviewResponseView(makeProposal({ proposalType: 'draft_invoice' }))).toBeNull();
    expect(
      reviewResponseView(makeProposal({ proposalType: 'review_response_proposal', payload: {} })),
    ).toBeNull();
    expect(
      reviewResponseView(
        makeProposal({ proposalType: 'review_response_proposal', payload: { publicResponse: { text: '   ' } } }),
      ),
    ).toBeNull();
    expect(reviewResponseView(undefined)).toBeNull();
  });
});

describe('agreementProposalView (E9)', () => {
  it('names the agreement and humanizes the cadence from the payload', () => {
    const view = agreementProposalView(
      makeProposal({
        proposalType: 'draft_invoice',
        payload: { agreementId: 'ag1', agreementName: 'Quarterly HVAC Tune-up', recurrenceRule: 'FREQ=QUARTERLY' },
      }),
    );
    expect(view).toEqual({ agreementId: 'ag1', name: 'Quarterly HVAC Tune-up', cadence: 'Quarterly' });
  });

  it('reads the agreement id from a record target and name/rule from sourceContext', () => {
    const view = agreementProposalView(
      makeProposal({
        targetEntityType: 'agreement',
        targetEntityId: 'ag2',
        sourceContext: { agreementName: 'Monthly Lawn Care', recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1' },
      }),
    );
    expect(view).toEqual({ agreementId: 'ag2', name: 'Monthly Lawn Care', cadence: 'Monthly' });
  });

  it('does NOT false-positive on an unrelated payload name', () => {
    // create_customer carries `name` but is not agreement-related.
    expect(
      agreementProposalView(makeProposal({ proposalType: 'create_customer', payload: { name: 'Jane Doe' } })),
    ).toBeNull();
    expect(agreementProposalView(makeProposal({ payload: {} }))).toBeNull();
    expect(agreementProposalView(undefined)).toBeNull();
  });
});
