import { describe, expect, it } from 'vitest';
import {
  CRITICAL_WINDOW_MS,
  computeProposalEvents,
  confidenceBand,
  hoursUntilExpiry,
  isCriticalProposal,
  mapInboxResponse,
  type PendingProposalSummary,
} from './proposalEvents';

const NOW = Date.UTC(2026, 5, 19, 12, 0, 0);

function p(id: string, expiresInMs?: number): PendingProposalSummary {
  return {
    id,
    summary: `s-${id}`,
    proposalType: 'draft_invoice',
    createdAt: new Date(NOW).toISOString(),
    expiresAt: expiresInMs === undefined ? undefined : new Date(NOW + expiresInMs).toISOString(),
  };
}

describe('isCriticalProposal', () => {
  it('is true within the 2h window, false beyond it or absent', () => {
    expect(isCriticalProposal(p('a', CRITICAL_WINDOW_MS - 1000), NOW)).toBe(true);
    expect(isCriticalProposal(p('b', CRITICAL_WINDOW_MS + 1000), NOW)).toBe(false);
    expect(isCriticalProposal(p('c'), NOW)).toBe(false);
    expect(isCriticalProposal(p('d', -1000), NOW)).toBe(false); // already expired
  });
});

describe('mapInboxResponse', () => {
  it('unwraps the prioritized `{ proposal }` envelope and normalizes dates', () => {
    const list = mapInboxResponse({
      data: [
        {
          proposal: {
            id: 'x',
            summary: 's',
            proposalType: 'draft_invoice',
            createdAt: NOW,
            expiresAt: NOW + 1000,
          },
        },
      ],
    });
    expect(list).toEqual([
      {
        id: 'x',
        summary: 's',
        proposalType: 'draft_invoice',
        createdAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 1000).toISOString(),
      },
    ]);
  });

  it('surfaces draft proposals (the inbox merges draft + ready_for_review)', () => {
    // A voice-created proposal lands in 'draft' but is still actionable. The
    // mapper carries it through regardless of status — the endpoint, not the
    // client, decides which statuses are in the inbox.
    const list = mapInboxResponse({
      data: [
        { proposal: { id: 'd', summary: 'voice draft', proposalType: 'draft_invoice', createdAt: NOW } },
      ],
    });
    expect(list.map((p) => p.id)).toEqual(['d']);
    expect(list[0].expiresAt).toBeUndefined();
  });

  it('handles a missing `data` field', () => {
    expect(mapInboxResponse({})).toEqual([]);
  });

  it('carries the proposal confidence score through for the inbox badge', () => {
    const list = mapInboxResponse({
      data: [
        {
          proposal: {
            id: 'c',
            summary: 's',
            proposalType: 'draft_invoice',
            createdAt: NOW,
            confidenceScore: 0.92,
          },
        },
      ],
    });
    expect(list[0].confidenceScore).toBe(0.92);
  });
});

describe('hoursUntilExpiry', () => {
  it('rounds whole hours until expiry, clamps at 0, and is null without an expiry', () => {
    expect(hoursUntilExpiry(new Date(NOW + 3 * 3_600_000).toISOString(), NOW)).toBe(3);
    expect(hoursUntilExpiry(new Date(NOW - 3_600_000).toISOString(), NOW)).toBe(0); // past
    expect(hoursUntilExpiry(undefined, NOW)).toBeNull();
  });
});

describe('confidenceBand', () => {
  it('buckets a 0–1 score, null when absent', () => {
    expect(confidenceBand(0.92)).toBe('high');
    expect(confidenceBand(0.7)).toBe('medium');
    expect(confidenceBand(0.4)).toBe('low');
    expect(confidenceBand(undefined)).toBeNull();
  });
});

describe('computeProposalEvents', () => {
  it('seeds a baseline (prevIds null) without firing new/critical events', () => {
    const list = [p('a'), p('b', 1000)]; // b is critical
    const diff = computeProposalEvents(null, new Set(), list, NOW);

    expect(diff.newProposals).toEqual([]);
    expect(diff.criticalProposals).toEqual([]);
    expect(diff.nextIds).toEqual(new Set(['a', 'b']));
    expect(diff.nextCritical).toEqual(new Set(['b'])); // recorded, not fired
  });

  it('fires onNewProposal once for a genuinely new id', () => {
    const prevIds = new Set(['a']);
    const diff = computeProposalEvents(prevIds, new Set(), [p('a'), p('c')], NOW);

    expect(diff.newProposals.map((x) => x.id)).toEqual(['c']);
  });

  it('fires critical once when a proposal crosses into the window, not again', () => {
    const crit = p('a', 1000);
    const prevIds = new Set(['a']);

    const first = computeProposalEvents(prevIds, new Set(), [crit], NOW);
    expect(first.criticalProposals.map((x) => x.id)).toEqual(['a']);

    const second = computeProposalEvents(first.nextIds, first.nextCritical, [crit], NOW);
    expect(second.criticalProposals).toEqual([]); // already recorded
  });
});
