// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingProposalSummary } from '../proposals/proposalEvents';

// react-native (AppState) is aliased to the host stub in vitest.config.ts.
const h = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));

// eslint-disable-next-line import/first
import { usePendingProposals } from './usePendingProposals';

type RawProposal = Pick<PendingProposalSummary, 'id' | 'summary' | 'proposalType'> & {
  createdAt: string;
  expiresAt?: string;
};

/** Inbox endpoint shape: { data: [{ proposal }] }. */
function inboxRes(proposals: RawProposal[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: proposals.map((proposal) => ({ proposal, urgency: 'normal' })) }),
  };
}

const draft = (id: string): RawProposal => ({
  id,
  summary: `summary ${id}`,
  proposalType: 'draft_invoice',
  createdAt: '2026-06-20T00:00:00Z',
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('usePendingProposals', () => {
  it('loads GET /api/proposals/inbox on mount and exposes count + proposals', async () => {
    h.api.mockResolvedValue(inboxRes([draft('a')]));
    const { result } = renderHook(() => usePendingProposals({ pollIntervalMs: 1_000_000 }));

    await waitFor(() => expect(result.current.count).toBe(1));
    expect(h.api).toHaveBeenCalledWith('/api/proposals/inbox');
    expect(result.current.proposals[0].summary).toBe('summary a');
    expect(result.current.error).toBeNull();
  });

  it('fires onNewProposal only for ids that appear after the baseline poll', async () => {
    const onNewProposal = vi.fn();
    h.api.mockResolvedValueOnce(inboxRes([draft('a')]));
    const { result } = renderHook(() =>
      usePendingProposals({ onNewProposal, pollIntervalMs: 1_000_000 }),
    );

    await waitFor(() => expect(result.current.count).toBe(1));
    expect(onNewProposal).not.toHaveBeenCalled(); // baseline does not fire

    h.api.mockResolvedValueOnce(inboxRes([draft('a'), draft('b')]));
    await act(async () => {
      await result.current.refresh();
    });

    expect(onNewProposal).toHaveBeenCalledTimes(1);
    expect(onNewProposal.mock.calls[0][0].id).toBe('b');
    expect(result.current.count).toBe(2);
  });

  it('surfaces the backend error message on a non-ok response', async () => {
    h.api.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'INTERNAL_ERROR', message: 'Inbox failed' }),
    });
    const { result } = renderHook(() => usePendingProposals({ pollIntervalMs: 1_000_000 }));

    await waitFor(() => expect(result.current.error).toBe('Inbox failed'));
  });

  it('does not fetch when disabled', async () => {
    h.api.mockResolvedValue(inboxRes([draft('a')]));
    renderHook(() => usePendingProposals({ enabled: false }));
    // Give any (unexpected) effect a chance to run.
    await new Promise((r) => setTimeout(r, 0));
    expect(h.api).not.toHaveBeenCalled();
  });
});
