// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// U12 — capture-class approvals queue offline; money/comms/irreversible never do.
const h = vi.hoisted(() => ({
  api: vi.fn(),
  online: true,
  queued: new Set<string>(),
  enqueueApproval: vi.fn(),
  removeApproval: vi.fn(),
}));

vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('../lib/connectivity', () => ({ isCurrentlyOnline: () => h.online }));
vi.mock('../offline/queueInstance', () => ({
  getOfflineQueue: () => ({
    hasQueuedApproval: (id: string) => h.queued.has(id),
    enqueueApproval: h.enqueueApproval,
    removeApproval: h.removeApproval,
  }),
}));

// eslint-disable-next-line import/first
import { useProposalReview } from './useProposalReview';

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function proposal(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    proposalType: 'add_note', // capture-class
    status: 'ready_for_review',
    summary: 'Add a note to the Lee job',
    approvedAt: null,
    ...over,
  };
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.online = true;
  h.queued.clear();
  h.enqueueApproval.mockImplementation(async (input: { payload: { proposalId: string } }) => {
    h.queued.add(input.payload.proposalId);
    return {};
  });
  h.removeApproval.mockImplementation(async (id: string) => h.queued.delete(id));
});

afterEach(() => {
  cleanup();
});

describe('useProposalReview — offline approvals (U12)', () => {
  it('queues a capture-class approve while offline (no fake countdown)', async () => {
    h.api.mockResolvedValue(okJson(proposal()));
    const { result } = renderHook(() => useProposalReview('p1'));
    await settle();
    h.online = false;

    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.phase).toBe('queued');
    expect(result.current.secondsLeft).toBe(0);
    expect(h.enqueueApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ proposalId: 'p1', proposalType: 'add_note' }),
      }),
    );
    // The approve POST never fired.
    expect(h.api).toHaveBeenCalledTimes(1); // only the initial GET
  });

  it('never queues a money-class approve — the offline failure surfaces instead', async () => {
    h.api.mockResolvedValueOnce(okJson(proposal({ proposalType: 'issue_invoice' })));
    const { result } = renderHook(() => useProposalReview('p1'));
    await settle();
    h.online = false;
    h.api.mockRejectedValueOnce(new Error('Network request failed'));

    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.phase).toBe('error');
    expect(h.enqueueApproval).not.toHaveBeenCalled();
  });

  it('queues when the connection drops mid-approve for a capture-class proposal', async () => {
    h.api.mockResolvedValueOnce(okJson(proposal()));
    const { result } = renderHook(() => useProposalReview('p1'));
    await settle();
    h.api.mockRejectedValueOnce(new Error('Network request failed'));

    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.phase).toBe('queued');
    expect(h.enqueueApproval).toHaveBeenCalledTimes(1);
  });

  it('cancel removes the queued approve and returns to review', async () => {
    h.api.mockResolvedValue(okJson(proposal()));
    const { result } = renderHook(() => useProposalReview('p1'));
    await settle();
    h.online = false;
    await act(async () => {
      await result.current.approve();
    });

    await act(async () => {
      await result.current.cancelQueuedApprove();
    });

    expect(h.removeApproval).toHaveBeenCalledWith('p1');
    expect(result.current.phase).toBe('review');
  });

  it('shows the queued state when reloading a proposal with a journaled approve', async () => {
    h.queued.add('p1');
    h.api.mockResolvedValue(okJson(proposal()));

    const { result } = renderHook(() => useProposalReview('p1'));
    await settle();

    expect(result.current.phase).toBe('queued');
  });
});
