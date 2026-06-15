import { describe, it, expect } from 'vitest';
import { createProposal } from '../../../src/proposals/proposal';
import { runSupervisorReview } from '../../../src/ai/supervisor/review';

describe('P2-037 — supervisor review', () => {
  it('flags low-confidence bookings as missed urgency', () => {
    const proposal = createProposal({
      tenantId: 't1',
      proposalType: 'create_booking',
      summary: 'Book AC repair',
      payload: {},
      confidenceScore: 0.7,
      createdBy: 'u1',
    });
    const { review, heldForCritical } = runSupervisorReview(proposal);
    expect(review.flags.some((f) => f.type === 'missed_urgency')).toBe(true);
    expect(heldForCritical).toBe(true);
  });

  it('skips non-supervised proposal types', () => {
    const proposal = createProposal({
      tenantId: 't1',
      proposalType: 'add_note',
      summary: 'Note',
      payload: {},
      createdBy: 'u1',
    });
    const { review } = runSupervisorReview(proposal);
    expect(review.flags).toHaveLength(0);
  });
});
