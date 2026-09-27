/**
 * #1277 (QA 2026-09-16) — the in-chat card said "Tap Edit to fill before
 * approval" over a gated catalog pick and offered only Approve (disabled) and
 * Dismiss: the candidates the inbox's one-tap picker renders never reached the
 * chat card. The card shape must carry them.
 *
 * Seam: `proposalSignals` — the function both chat card serializers use to
 * project a proposal's gates onto the card.
 */
import { describe, it, expect } from 'vitest';
import { proposalSignals } from '../../src/routes/assistant';

describe('#1277 — the chat card carries what lifts a gated pick', () => {
  it('projects the catalog candidates for each gated line onto the card', () => {
    const signals = proposalSignals(
      {
        lineItems: [
          { description: 'Water heater', quantity: 1, pricingSource: 'ambiguous' },
          { description: 'Permit', quantity: 1, unitPriceCents: 15000, pricingSource: 'catalog' },
        ],
      },
      {
        missingFields: ['lineItems[0].catalogItemId'],
        catalogResolution: {
          '0': [
            { id: 'cat-40', name: 'Water heater 40 gal', unitPriceCents: 110000, score: 0.8 },
            { id: 'cat-50', name: 'Water heater 50 gal', unitPriceCents: 130000, score: 0.8 },
          ],
        },
      },
    );

    expect(signals.linePicks).toEqual([
      {
        lineIndex: 0,
        description: 'Water heater',
        candidates: [
          { id: 'cat-40', name: 'Water heater 40 gal', unitPriceCents: 110000, score: 0.8 },
          { id: 'cat-50', name: 'Water heater 50 gal', unitPriceCents: 130000, score: 0.8 },
        ],
      },
    ]);
  });

  // The chat Edit for a customerId gate was a free-text "Customer name or ID"
  // box; a typed name is not an id, so Save → PUT /api/proposals/:id → 400.
  // When the gate is waiting on a question with candidates, the card offers
  // those candidates — a pick is a real id.
  it('projects the pending question\'s candidates as a pick for the gated id', () => {
    const signals = proposalSignals(
      { customerReference: 'Ashworth', lineItems: [] },
      {
        missingFields: ['customerId'],
        pendingEntityAmbiguity: {
          entityKind: 'customer',
          reference: 'Ashworth',
          refKey: 'customerId',
          attemptCount: 0,
          candidates: [
            { id: 'cust-morgan', name: 'Morgan Ashworth', score: 0.9, hint: '12 Elm St' },
            { id: 'cust-riley', name: 'Riley Ashworth', score: 0.9 },
          ],
        },
      },
    );

    expect(signals.referencePick).toEqual({
      field: 'customerId',
      reference: 'Ashworth',
      candidates: [
        { id: 'cust-morgan', label: 'Morgan Ashworth', hint: '12 Elm St', score: 0.9 },
        { id: 'cust-riley', label: 'Riley Ashworth', score: 0.9 },
      ],
    });
  });
});
