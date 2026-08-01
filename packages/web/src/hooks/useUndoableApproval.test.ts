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

  it('falls back to a full client window when the response carries no timing', () => {
    const requestUndo = vi.fn().mockResolvedValue(okResponse());
    const { result } = renderHook(() => useUndoableApproval({ requestUndo }));

    act(() => {
      result.current.start({ proposalId: 'p-1', summary: 'Add a note', response: null });
    });

    expect(result.current.isActive).toBe(true);
    expect(result.current.remainingMs).toBe(UNDO_WINDOW_MS);
  });
});
