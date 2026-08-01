/**
 * P2-033 — usePendingProposals hook tests.
 *
 * Covers the five behaviours called out in the story spec:
 *   - Badge count: hook surfaces the number of ready_for_review proposals
 *   - Auto-refresh: polling re-fetches on the interval
 *   - Toast: onNewProposal fires for genuinely new ids (and skips the
 *     initial baseline snapshot)
 *   - Tab inactive: polling pauses while document.hidden is true
 *   - Action: refresh() refetches immediately so the badge decrements
 *     after an approval without waiting for the next tick
 *
 * The Clerk mock comes from `test-setup.ts`; `useApiClient` resolves to
 * a Bearer-injecting fetch wrapper, but the test stubs `globalThis.fetch`
 * directly so we control responses and counts.
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePendingProposals, _resetPendingProposalsCacheForTests } from './usePendingProposals';

interface ProposalRow {
  id: string;
  summary: string;
  proposalType: string;
  createdAt: string;
}

function makeList(rows: ProposalRow[]): Response {
  return {
    ok: true,
    json: async () => ({ data: rows, total: rows.length }),
  } as Response;
}

function row(id: string, summary = `Proposal ${id}`): ProposalRow {
  return {
    id,
    summary,
    proposalType: 'create_appointment',
    createdAt: '2026-05-18T00:00:00.000Z',
  };
}

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('P2-033 — usePendingProposals', () => {
  beforeEach(() => {
    _resetPendingProposalsCacheForTests();
    vi.restoreAllMocks();
    setDocumentHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Badge count — shows correct number of pending proposals', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeList([row('p1'), row('p2'), row('p3')]),
    );

    const { result } = renderHook(() => usePendingProposals());

    await waitFor(() => expect(result.current.count).toBe(3));
    expect(result.current.proposals).toHaveLength(3);
    expect(result.current.error).toBeNull();
  });

  it('Auto-refresh — new proposal appears without manual refresh', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeList([row('p1')]))
      .mockResolvedValueOnce(makeList([row('p1'), row('p2')]));

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() =>
      usePendingProposals({ pollIntervalMs: 1_000 }),
    );

    await waitFor(() => expect(result.current.count).toBe(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });

    await waitFor(() => expect(result.current.count).toBe(2));
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('Toast — onNewProposal fires for ids that were not in the prior snapshot', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeList([row('p1')]))
      .mockResolvedValueOnce(makeList([row('p1'), row('p2', 'AC unit needs swap')]));

    const onNewProposal = vi.fn();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() =>
      usePendingProposals({ pollIntervalMs: 1_000, onNewProposal }),
    );

    await waitFor(() => expect(result.current.count).toBe(1));
    // Baseline poll must NOT toast — otherwise mount blasts the operator
    // with one toast per existing proposal.
    expect(onNewProposal).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });

    await waitFor(() => expect(onNewProposal).toHaveBeenCalledTimes(1));
    expect(onNewProposal).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p2', summary: 'AC unit needs swap' }),
    );
  });

  it('Tab inactive — polling paused when document.hidden', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeList([row('p1')]),
    );

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() =>
      usePendingProposals({ pollIntervalMs: 1_000 }),
    );

    await waitFor(() => expect(result.current.count).toBe(1));
    const callsAfterInitial = fetchSpy.mock.calls.length;

    act(() => {
      setDocumentHidden(true);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    // No further polls fired while hidden.
    expect(fetchSpy.mock.calls.length).toBe(callsAfterInitial);

    // Resume on visibility — fires a one-shot refresh plus restarts
    // the interval, so we expect at least one new call.
    act(() => {
      setDocumentHidden(false);
    });

    await waitFor(() =>
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsAfterInitial),
    );
  });

  it('Action — refresh() refetches immediately so the badge decrements after approval', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeList([row('p1'), row('p2')]))
      .mockResolvedValueOnce(makeList([row('p1')]));

    const { result } = renderHook(() => usePendingProposals());
    await waitFor(() => expect(result.current.count).toBe(2));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.count).toBe(1);
    expect(fetchSpy.mock.calls.length).toBe(2);
  });

  it('does not fetch when disabled', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeList([row('p1')]),
    );

    renderHook(() => usePendingProposals({ enabled: false }));

    // Give React a tick to settle any pending effects.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces fetch errors without crashing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    const { result } = renderHook(() => usePendingProposals());

    await waitFor(() => expect(result.current.error).toBe('HTTP 500'));
    expect(result.current.count).toBe(0);
  });
});
