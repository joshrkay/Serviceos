// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));

// eslint-disable-next-line import/first
import { useProposalReview } from './useProposalReview';

const T0 = Date.UTC(2026, 5, 20, 0, 0, 0);

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function err(status: number, body: unknown = {}) {
  return { ok: false, status, json: async () => body };
}
function proposal(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    proposalType: 'draft_invoice',
    status: 'ready_for_review',
    summary: 'Invoice Acme $123.45',
    explanation: 'Grounded in the catalog.',
    confidenceScore: 0.9,
    payload: { customerName: 'Acme', amountCents: 12345 },
    approvedAt: null,
    ...over,
  };
}

/** Drain a few microtask hops (api -> json -> setState) under fake timers. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useProposalReview', () => {
  it('loads the proposal into the review phase', async () => {
    h.api.mockResolvedValue(okJson(proposal()));
    const { result } = renderHook(() => useProposalReview('p1'));
    await settle();
    expect(result.current.phase).toBe('review');
    expect(result.current.proposal?.summary).toBe('Invoice Acme $123.45');
    expect(h.api).toHaveBeenCalledWith('/api/proposals/p1');
  });

  it('approves, counts the undo window down, and commits at zero', async () => {
    h.api.mockImplementation((url: string) => {
      if (url === '/api/proposals/p1/approve') {
        return Promise.resolve(
          okJson(proposal({ status: 'approved', approvedAt: new Date(T0).toISOString() })),
        );
      }
      return Promise.resolve(okJson(proposal()));
    });

    const { result } = renderHook(() => useProposalReview('p1'));
    await settle();

    await act(async () => {
      await result.current.approve();
    });
    expect(result.current.phase).toBe('approved');
    expect(result.current.secondsLeft).toBe(5);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.secondsLeft).toBe(4);

    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(result.current.phase).toBe('committed');
    expect(result.current.secondsLeft).toBe(0);
  });

  it('undoes within the window', async () => {
    h.api.mockImplementation((url: string) => {
      if (url === '/api/proposals/p1/approve') {
        return Promise.resolve(
          okJson(proposal({ status: 'approved', approvedAt: new Date(T0).toISOString() })),
        );
      }
      if (url === '/api/proposals/p1/undo') {
        return Promise.resolve(okJson(proposal({ status: 'undone' })));
      }
      return Promise.resolve(okJson(proposal()));
    });

    const { result } = renderHook(() => useProposalReview('p1'));
    await settle();
    await act(async () => {
      await result.current.approve();
    });
    await act(async () => {
      await result.current.undo();
    });
    expect(result.current.phase).toBe('undone');
    expect(h.api).toHaveBeenCalledWith('/api/proposals/p1/undo', { method: 'POST' });
  });

  it('treats a 409 on undo as the window having closed (committed)', async () => {
    h.api.mockImplementation((url: string) => {
      if (url === '/api/proposals/p1/approve') {
        return Promise.resolve(
          okJson(proposal({ status: 'approved', approvedAt: new Date(T0).toISOString() })),
        );
      }
      if (url === '/api/proposals/p1/undo') return Promise.resolve(err(409));
      return Promise.resolve(okJson(proposal()));
    });

    const { result } = renderHook(() => useProposalReview('p1'));
    await settle();
    await act(async () => {
      await result.current.approve();
    });
    await act(async () => {
      await result.current.undo();
    });
    expect(result.current.phase).toBe('committed');
  });

  it('surfaces a load error with the backend message', async () => {
    h.api.mockResolvedValue(err(500, { error: 'INTERNAL_ERROR', message: 'Load failed' }));
    const { result } = renderHook(() => useProposalReview('p1'));
    await settle();
    expect(result.current.phase).toBe('error');
    expect(result.current.error).toBe('Load failed');
  });
});
