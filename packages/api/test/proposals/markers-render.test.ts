import { describe, it, expect } from 'vitest';
import { createProposal } from '../../src/proposals/proposal';
import {
  deriveMarkersFromProposal,
  formatMarkersForSms,
  formatMarkersForInbox,
} from '../../src/proposals/markers/render';

describe('P2-035 — confidence markers', () => {
  it('derives uncatalogued line marker from pricingSource', () => {
    const proposal = createProposal({
      tenantId: 't1',
      proposalType: 'draft_estimate',
      status: 'ready_for_review',
      summary: 'Estimate',
      payload: {
        lineItems: [
          { description: 'Custom gasket', pricingSource: 'uncatalogued', unitPriceCents: 2500 },
        ],
      },
      createdBy: 'u1',
    });
    const markers = deriveMarkersFromProposal(proposal);
    expect(markers.some((m) => m.type === 'uncatalogued_price')).toBe(true);
    const smsTail = formatMarkersForSms(markers);
    expect(smsTail.length).toBeLessThanOrEqual(80);
    expect(formatMarkersForInbox(markers).length).toBeGreaterThan(0);
  });
});
