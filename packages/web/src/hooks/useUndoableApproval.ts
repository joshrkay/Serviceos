import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Matches the execution layer's UNDO_WINDOW_MS (api proposals/lifecycle.ts).
 * The client-side fallback when the server response carries no timing.
 */
export const UNDO_WINDOW_MS = 5000;

/**
 * The timing fields the approve endpoint now returns (Finding 2). Both are
 * ISO strings and both optional — an older server (or a non-approve response)
 * simply omits them and the hook falls back to a full client window.
 */
export interface ApproveResponseLike {
  /** Server-stamped approval instant. */
  approvedAt?: string;
  /** approvedAt + UNDO_WINDOW_MS — the instant the undo window closes. */
  undoExpiresAt?: string;
}

export interface StartUndoInput {
  proposalId: string;
  summary: string;
  /** The parsed approve-endpoint JSON, used to anchor the countdown. */
  response?: ApproveResponseLike | null;
}

export interface UseUndoableApprovalOptions {
  /** Fires the undo/cancel network call for the given proposal id. */
  requestUndo: (proposalId: string) => Promise<Response>;
  /** Called after a successful undo (e.g. to refresh a list). */
  onUndone?: (proposalId: string) => void;
  /** Called with a human-readable message when the undo call fails. */
  onError?: (message: string) => void;
  /** Overridable for tests; defaults to UNDO_WINDOW_MS. */
  windowMs?: number;
}

export interface UndoableApproval {
  proposalId: string | null;
  summary: string;
  /** True while an undo affordance should be shown. */
  isActive: boolean;
  /** Milliseconds left before the window closes (0 when inactive). */
  remainingMs: number;
  /** The full window length, for the progress-bar denominator. */
  windowMs: number;
  /** Begin (or restart) the countdown from the server's undo window. */
  start: (input: StartUndoInput) => void;
  /** Fire the undo call for the active proposal and dismiss the toast. */
  undo: () => Promise<void>;
  /** Dismiss the toast without undoing. */
  dismiss: () => void;
}

/**
 * Resolve the absolute instant (epoch ms) the undo window closes.
 *
 * Preference order, so the countdown is as truthful as the server allows:
 *   1. `undoExpiresAt` — the server's own window-close instant.
 *   2. `approvedAt + windowMs` — derive it when only the approval stamp rode.
 *   3. `now + windowMs` — no server timing at all (older server); a full
 *      client window so the affordance still works, just not latency-corrected.
 */
function resolveExpiryMs(
  response: ApproveResponseLike | null | undefined,
  now: number,
  windowMs: number,
): number {
  const undoExpiresAt = response?.undoExpiresAt;
  if (undoExpiresAt) {
    const t = Date.parse(undoExpiresAt);
    if (!Number.isNaN(t)) return t;
  }
  const approvedAt = response?.approvedAt;
  if (approvedAt) {
    const t = Date.parse(approvedAt);
    if (!Number.isNaN(t)) return t + windowMs;
  }
  return now + windowMs;
}

/**
 * Finding 2 — server-driven approval-undo countdown, shared by every surface
 * that approves proposals (inbox, assistant) so the affordance stays identical.
 *
 * The window is anchored to the SERVER's `undoExpiresAt` (falling back to
 * `approvedAt + windowMs`), NOT a fresh client 5s: the approve round-trip has
 * already eaten part of the real window, so a client-anchored timer would keep
 * offering an undo the server has already 409'd. When the true remaining time
 * is <= 0 the affordance never shows; a partially-elapsed window shows only the
 * TRUE remaining time.
 */
export function useUndoableApproval(options: UseUndoableApprovalOptions): UndoableApproval {
  const { requestUndo, onUndone, onError } = options;
  const windowMs = options.windowMs ?? UNDO_WINDOW_MS;

  const [proposalId, setProposalId] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [remainingMs, setRemainingMs] = useState(0);

  const expiresAtRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    expiresAtRef.current = null;
    setProposalId(null);
    setSummary('');
    setRemainingMs(0);
  }, [clearTimer]);

  // Clear the interval on unmount.
  useEffect(() => () => clearTimer(), [clearTimer]);

  const start = useCallback(
    (input: StartUndoInput) => {
      clearTimer();
      const now = Date.now();
      const expiresAt = resolveExpiryMs(input.response, now, windowMs);
      const remaining = expiresAt - now;
      if (remaining <= 0) {
        // Latency already closed the window — do not offer an undo the server
        // would reject. Leave the toast inactive.
        expiresAtRef.current = null;
        setProposalId(null);
        setSummary('');
        setRemainingMs(0);
        return;
      }
      expiresAtRef.current = expiresAt;
      setProposalId(input.proposalId);
      setSummary(input.summary);
      setRemainingMs(remaining);
      timerRef.current = setInterval(() => {
        const left = (expiresAtRef.current ?? 0) - Date.now();
        if (left <= 0) {
          reset();
          return;
        }
        setRemainingMs(left);
      }, 100);
    },
    [clearTimer, reset, windowMs],
  );

  const undo = useCallback(async () => {
    const id = proposalId;
    if (!id) return;
    reset();
    try {
      const res = await requestUndo(id);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { message?: string })?.message ?? `HTTP ${res.status}`);
      }
      onUndone?.(id);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'Undo failed');
    }
  }, [proposalId, reset, requestUndo, onUndone, onError]);

  return {
    proposalId,
    summary,
    isActive: proposalId !== null,
    remainingMs,
    windowMs,
    start,
    undo,
    dismiss: reset,
  };
}
