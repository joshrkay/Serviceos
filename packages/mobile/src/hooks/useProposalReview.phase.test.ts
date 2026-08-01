import { describe, expect, it } from 'vitest';
import { phaseForStatus } from './useProposalReview';

const NOW = Date.parse('2026-06-20T12:00:00.000Z');

describe('phaseForStatus', () => {
  it('keeps draft / ready_for_review on the review (Approve) phase', () => {
    expect(phaseForStatus('draft', null, NOW)).toBe('review');
    expect(phaseForStatus('ready_for_review', null, NOW)).toBe('review');
  });

  it('shows the undo countdown for a just-approved proposal still in the window', () => {
    const approvedAt = new Date(NOW - 2000).toISOString(); // 2s ago, 5s window
    expect(phaseForStatus('approved', approvedAt, NOW)).toBe('approved');
  });

  it('commits an approved proposal once the undo window has elapsed', () => {
    const approvedAt = new Date(NOW - 10_000).toISOString(); // 10s ago
    expect(phaseForStatus('approved', approvedAt, NOW)).toBe('committed');
  });

  it('treats an executed proposal as committed (no Approve button)', () => {
    // The reported bug: a "Done" push deep-links to an executed proposal.
    expect(phaseForStatus('executed', null, NOW)).toBe('committed');
  });

  it('shows terminal non-actionable states for undone/rejected/expired', () => {
    expect(phaseForStatus('undone', null, NOW)).toBe('undone');
    expect(phaseForStatus('rejected', null, NOW)).toBe('undone');
    expect(phaseForStatus('expired', null, NOW)).toBe('undone');
  });
});
