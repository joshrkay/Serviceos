import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUndoableApproval, UNDO_WINDOW_MS } from './useUndoableApproval';

const BASE = new Date('2026-07-12T10:00:00.000Z');

function isoFromNow(offsetMs: number): string {
  return new Date(BASE.getTime() + offsetMs).toISOString();
}

/** A resolved OK/!OK fetch Response for the undo call. */
function okResponse(ok = true): Response {
  return new Response(JSON.stringify(ok ? {} : { message: 'nope' }), {
    status: ok ? 200 : 409,
    headers: { 'content-type': 'application/json' },
  });
}

describe('useUndoableApproval — server-driven undo window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers the FULL window when undoExpiresAt is ~now + window', () => {
    const requestUndo = vi.fn().mockResolvedValue(okResponse());
    const { result } = renderHook(() => useUndoableApproval({ requestUndo }));

    act(() => {
      result.current.start({
        proposalId: 'p-1',
        summary: 'Add a note',
        response: { approvedAt: isoFromNow(0), undoExpiresAt: isoFromNow(UNDO_WINDOW_MS) },
      });
    });

    expect(result.current.isActive).toBe(true);
    expect(result.current.remainingMs).toBe(UNDO_WINDOW_MS);
    expect(result.current.summary).toBe('Add a note');

    // Halfway through, only the TRUE remaining time is shown.
    act(() => { vi.advanceTimersByTime(2500); });
    expect(result.current.remainingMs).toBeLessThanOrEqual(2500);
    expect(result.current.remainingMs).toBeGreaterThan(2300);
    expect(result.current.isActive).toBe(true);
  });

  it('expires and disables the affordance when the window reaches 0', () => {
    const requestUndo = vi.fn().mockResolvedValue(okResponse());
    const { result } = renderHook(() => useUndoableApproval({ requestUndo }));

    act(() => {
      result.current.start({
        proposalId: 'p-1',
        summary: 'Add a note',
        response: { undoExpiresAt: isoFromNow(UNDO_WINDOW_MS) },
      });
    });
    expect(result.current.isActive).toBe(true);

    act(() => { vi.advanceTimersByTime(UNDO_WINDOW_MS + 100); });
    expect(result.current.isActive).toBe(false);
    expect(result.current.remainingMs).toBe(0);
  });

  it('shows ONLY the true remaining time for a short (latency-eaten) window', () => {
    const requestUndo = vi.fn().mockResolvedValue(okResponse());
    const { result } = renderHook(() => useUndoableApproval({ requestUndo }));

    // Server says the window closes in 1.2s (the approve round-trip already
    // ate 3.8s of the real 5s). The toast must reflect 1.2s, not a fresh 5s.
    act(() => {
      result.current.start({
        proposalId: 'p-1',
        summary: 'Add a note',
        response: { undoExpiresAt: isoFromNow(1200) },
      });
    });

    expect(result.current.isActive).toBe(true);
    expect(result.current.remainingMs).toBe(1200);

    act(() => { vi.advanceTimersByTime(1300); });
    expect(result.current.isActive).toBe(false);
  });

  it('never offers an undo when the window has already closed', () => {
    const requestUndo = vi.fn().mockResolvedValue(okResponse());
    const { result } = renderHook(() => useUndoableApproval({ requestUndo }));

    act(() => {
      result.current.start({
        proposalId: 'p-1',
        summary: 'Add a note',
        response: { undoExpiresAt: isoFromNow(-10) }, // already in the past
      });
    });

    expect(result.current.isActive).toBe(false);
    expect(result.current.remainingMs).toBe(0);
  });

  it('undo() fires the undo call, dismisses the toast, and reports success', async () => {
    const requestUndo = vi.fn().mockResolvedValue(okResponse(true));
    const onUndone = vi.fn();
    const { result } = renderHook(() => useUndoableApproval({ requestUndo, onUndone }));

    act(() => {
      result.current.start({
        proposalId: 'p-9',
        summary: 'Add a note',
        response: { undoExpiresAt: isoFromNow(UNDO_WINDOW_MS) },
      });
    });
    expect(result.current.isActive).toBe(true);

    await act(async () => {
      await result.current.undo();
    });

    expect(requestUndo).toHaveBeenCalledWith('p-9');
    expect(onUndone).toHaveBeenCalledWith('p-9');
    expect(result.current.isActive).toBe(false);
  });

  it('undo() surfaces an error when the undo call fails', async () => {
    const requestUndo = vi.fn().mockResolvedValue(okResponse(false));
    const onError = vi.fn();
    const { result } = renderHook(() => useUndoableApproval({ requestUndo, onError }));

    act(() => {
      result.current.start({
        proposalId: 'p-9',
        summary: 'Add a note',
        response: { undoExpiresAt: isoFromNow(UNDO_WINDOW_MS) },
      });
    });

    await act(async () => {
      await result.current.undo();
    });

    expect(requestUndo).toHaveBeenCalledWith('p-9');
    expect(onError).toHaveBeenCalledWith('nope');
    expect(result.current.isActive).toBe(false);
  });

  /**
   * Review J3 — the `now + windowMs` fallback INVENTED a fresh, full client
   * window whenever the server sent no timing, which is exactly what this
   * hook's own doc comment swears never happens and what the API-side doc
   * (routes/assistant.ts) states as "no stamp ⇒ no window ⇒ no affordance".
   * It was reachable: the assistant chat parses the raw LLM completion with
   * `assistantReplySchema`, whose `status` accepts 'Approved' FROM THE MODEL,
   * and returns `parsed.proposal` UNMAPPED — no `undoExpiresAt`, possibly not
   * even a real proposal id. Clicking Undo then POSTed to a bogus id and the
   * operator got a raw error toast.
   */
  it('offers NO affordance when the response carries no timing at all', () => {
    const requestUndo = vi.fn().mockResolvedValue(okResponse());
    const { result } = renderHook(() => useUndoableApproval({ requestUndo }));

    act(() => {
      result.current.start({ proposalId: 'p-1', summary: 'Add a note', response: null });
    });

    expect(result.current.isActive).toBe(false);
    expect(result.current.remainingMs).toBe(0);
    expect(requestUndo).not.toHaveBeenCalled();
  });

  it('still allows a client-anchored window when a caller explicitly opts in', () => {
    const requestUndo = vi.fn().mockResolvedValue(okResponse());
    const { result } = renderHook(() =>
      useUndoableApproval({ requestUndo, allowClientOnlyWindow: true }),
    );

    act(() => {
      result.current.start({ proposalId: 'p-1', summary: 'Add a note', response: null });
    });

    expect(result.current.isActive).toBe(true);
    expect(result.current.remainingMs).toBe(UNDO_WINDOW_MS);
  });

  /**
   * Review N11 — a DURATION carries no clock, so it survives skew. An
   * absolute `undoExpiresAt` differenced against a skewed `Date.now()` either
   * hides a valid undo or offers one the server 409s, and on the chat path
   * the round trip is an LLM call so the budget is already thin.
   */
  it('prefers the server-sent remaining DURATION over the absolute instant', () => {
    const requestUndo = vi.fn().mockResolvedValue(okResponse());
    const { result } = renderHook(() => useUndoableApproval({ requestUndo }));

    act(() => {
      result.current.start({
        proposalId: 'p-1',
        summary: 'Add a note',
        response: {
          // A client clock running 4s FAST would read this instant as almost
          // closed; the duration says otherwise and wins.
          undoExpiresAt: isoFromNow(-4000),
          undoRemainingMs: 3200,
        },
      });
    });

    expect(result.current.isActive).toBe(true);
    expect(result.current.remainingMs).toBe(3200);
  });

  it('treats a server-sent remaining duration of 0 as no affordance', () => {
    const requestUndo = vi.fn().mockResolvedValue(okResponse());
    const { result } = renderHook(() => useUndoableApproval({ requestUndo }));

    act(() => {
      result.current.start({
        proposalId: 'p-1',
        summary: 'Add a note',
        response: { undoExpiresAt: isoFromNow(UNDO_WINDOW_MS), undoRemainingMs: 0 },
      });
    });

    expect(result.current.isActive).toBe(false);
  });

  /**
   * Review N12 — `undo()` called `reset()` and THEN awaited, so two clicks in
   * one React tick both read the pre-reset closure and fired two POSTs. The
   * second 409s right after a successful undo, and the operator sees an error
   * toast for an undo that worked.
   */
  it('fires exactly one request when Undo is double-clicked in a single tick', async () => {
    let release: (r: Response) => void = () => {};
    const requestUndo = vi.fn(
      () => new Promise<Response>((resolve) => { release = resolve; }),
    );
    const onError = vi.fn();
    const { result } = renderHook(() => useUndoableApproval({ requestUndo, onError }));

    act(() => {
      result.current.start({
        proposalId: 'p-double',
        summary: 'Add a note',
        response: { undoRemainingMs: UNDO_WINDOW_MS },
      });
    });

    await act(async () => {
      void result.current.undo();
      void result.current.undo();
      release(okResponse());
    });

    expect(requestUndo).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  /**
   * Review N13 — the toast held ONE slot, so approving two proposals within
   * the 5s window silently discarded the first one's still-open undo. Two
   * pending cards and two taps is an ordinary thing to do.
   */
  describe('more than one open window', () => {
    function startTwo(result: { current: ReturnType<typeof useUndoableApproval> }) {
      act(() => {
        result.current.start({
          proposalId: 'p-first',
          summary: 'First note',
          response: { undoRemainingMs: UNDO_WINDOW_MS },
        });
      });
      act(() => { vi.advanceTimersByTime(1000); });
      act(() => {
        result.current.start({
          proposalId: 'p-second',
          summary: 'Second note',
          response: { undoRemainingMs: UNDO_WINDOW_MS },
        });
      });
    }

    it('does not discard the first window when a second approval lands', async () => {
      const requestUndo = vi.fn().mockResolvedValue(okResponse());
      const { result } = renderHook(() => useUndoableApproval({ requestUndo }));
      startTwo(result);

      // The one closing SOONEST is the one on screen — it is the one about to
      // be lost.
      expect(result.current.summary).toBe('First note');

      await act(async () => { await result.current.undo(); });
      expect(requestUndo).toHaveBeenCalledWith('p-first');

      // …and the second is still offered, on ITS OWN window (it was approved
      // 1s later, so it legitimately has a full 5s left at this instant).
      expect(result.current.isActive).toBe(true);
      expect(result.current.summary).toBe('Second note');
      expect(result.current.remainingMs).toBe(UNDO_WINDOW_MS);
      act(() => { vi.advanceTimersByTime(1500); });
      expect(result.current.remainingMs).toBe(UNDO_WINDOW_MS - 1500);

      await act(async () => { await result.current.undo(); });
      expect(requestUndo).toHaveBeenLastCalledWith('p-second');
      expect(result.current.isActive).toBe(false);
    });

    it('dismissing the visible one reveals the next, and lapsing drops only the lapsed', () => {
      const requestUndo = vi.fn().mockResolvedValue(okResponse());
      const { result } = renderHook(() => useUndoableApproval({ requestUndo }));
      startTwo(result);

      act(() => { result.current.dismiss(); });
      expect(result.current.summary).toBe('Second note');

      // Run past the second's expiry — the affordance closes on its own.
      act(() => { vi.advanceTimersByTime(UNDO_WINDOW_MS); });
      expect(result.current.isActive).toBe(false);
    });

    it('re-starting the SAME proposal replaces its entry rather than queueing a duplicate', async () => {
      const requestUndo = vi.fn().mockResolvedValue(okResponse());
      const { result } = renderHook(() => useUndoableApproval({ requestUndo }));

      act(() => {
        result.current.start({
          proposalId: 'p-same',
          summary: 'Note',
          response: { undoRemainingMs: UNDO_WINDOW_MS },
        });
        result.current.start({
          proposalId: 'p-same',
          summary: 'Note',
          response: { undoRemainingMs: UNDO_WINDOW_MS },
        });
      });

      await act(async () => { await result.current.undo(); });
      expect(result.current.isActive).toBe(false);
    });
  });
});
