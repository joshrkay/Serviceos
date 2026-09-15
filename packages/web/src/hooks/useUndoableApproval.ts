import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Matches the execution layer's UNDO_WINDOW_MS (api proposals/lifecycle.ts).
 * The denominator for the progress bar, and the length of the OPT-IN
 * client-anchored window (see `allowClientOnlyWindow`).
 */
export const UNDO_WINDOW_MS = 5000;

/**
 * The timing fields the approve endpoint returns.
 *
 * `undoRemainingMs` (review N11) is preferred over `undoExpiresAt`: a
 * DURATION carries no clock, so it survives skew between the server's clock
 * and the browser's. An absolute instant differenced against a local
 * `Date.now()` loses the skew straight out of a 5-second budget that the
 * approve round trip — on the chat path, an LLM call — has already eaten most
 * of. Skew one way hides a valid undo; the other way offers one the server
 * then 409s with UNDO_WINDOW_CLOSED.
 *
 * `undoExpiresAt` is retained as the second preference so a server that
 * predates `undoRemainingMs` still drives a real countdown.
 */
export interface ApproveResponseLike {
  /** Server-stamped approval instant. */
  approvedAt?: string;
  /** approvedAt + UNDO_WINDOW_MS — the instant the undo window closes. */
  undoExpiresAt?: string;
  /** Milliseconds of window left when the server wrote the response. */
  undoRemainingMs?: number;
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
  /**
   * Review J3 — OPT IN to inventing a full client-side window when the
   * response carries no server timing at all. Default false, and no
   * production caller sets it.
   *
   * It used to be the unconditional fallback, and that made the hook lie in
   * precisely the case its own comment said could not happen. The assistant
   * chat surface reaches it: `assistantReplySchema` accepts `status:
   * 'Approved'` FROM THE MODEL and the route returns `parsed.proposal`
   * UNMAPPED — no `undoExpiresAt`, possibly not even a real proposal id — so
   * the operator was offered a fresh 5-second undo for something the server
   * had no window for, and clicking it POSTed to a bogus id. The API-side
   * contract is explicit ("no stamp ⇒ no window ⇒ no affordance"); this now
   * matches it.
   */
  allowClientOnlyWindow?: boolean;
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

/** One approval still inside its undo window. */
interface PendingUndo {
  proposalId: string;
  summary: string;
  /** Local-clock epoch ms at which this window closes. */
  expiresAt: number;
}

/**
 * Resolve the local-clock instant this window closes, or null when the
 * response carries no server timing and the caller has not opted in to a
 * client-invented one.
 *
 * Preference order, so the countdown is as truthful as the server allows:
 *   1. `undoRemainingMs` — a duration, immune to clock skew (N11).
 *   2. `undoExpiresAt` — the server's window-close instant.
 *   3. `approvedAt + windowMs` — derive it when only the approval stamp rode.
 *   4. `now + windowMs` — ONLY when `allowClientOnlyWindow` (J3).
 */
function resolveExpiryMs(
  response: ApproveResponseLike | null | undefined,
  now: number,
  windowMs: number,
  allowClientOnlyWindow: boolean,
): number | null {
  const remaining = response?.undoRemainingMs;
  if (typeof remaining === 'number' && Number.isFinite(remaining)) {
    return now + remaining;
  }
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
  return allowClientOnlyWindow ? now + windowMs : null;
}

/**
 * Finding 2 — server-driven approval-undo countdown, shared by every surface
 * that approves proposals (inbox, assistant) so the affordance stays identical.
 *
 * The window is anchored to the SERVER's timing, NOT a fresh client 5s: the
 * approve round-trip has already eaten part of the real window, so a
 * client-anchored timer would keep offering an undo the server has already
 * 409'd. When the true remaining time is <= 0 the affordance never shows; a
 * partially-elapsed window shows only the TRUE remaining time.
 *
 * Review N13 — more than one approval can be inside its window at once (two
 * pending cards, two taps, five seconds). The hook keeps a QUEUE and shows
 * the entry closing SOONEST; undoing, dismissing, or lapsing reveals the
 * next. The single visible-slot API (`summary`/`remainingMs`/`isActive`) is
 * unchanged, so neither surface's JSX had to move — the previous version
 * simply DROPPED the earlier window on a second `start()`.
 */
export function useUndoableApproval(options: UseUndoableApprovalOptions): UndoableApproval {
  const { requestUndo, onUndone, onError } = options;
  const windowMs = options.windowMs ?? UNDO_WINDOW_MS;
  const allowClientOnlyWindow = options.allowClientOnlyWindow ?? false;

  const [pending, setPending] = useState<PendingUndo[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * Review N12 — `undo()` used to `reset()` and THEN await, so two clicks in
   * one React tick both read the pre-reset closure and fired two POSTs. State
   * cannot guard that (both reads see the same render's value); a ref is
   * written synchronously and is visible to the second call immediately.
   */
  const inFlightRef = useRef<Set<string>>(new Set());

  // One interval for the whole queue. It exists only while something is
  // pending, and drops entries as they lapse.
  useEffect(() => {
    if (pending.length === 0) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    timerRef.current = setInterval(() => {
      const tick = Date.now();
      setNow(tick);
      setPending((prev) => {
        const live = prev.filter((p) => p.expiresAt > tick);
        return live.length === prev.length ? prev : live;
      });
    }, 100);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [pending.length]);

  // The one closing soonest — it is the one about to be lost.
  const current = useMemo(() => {
    if (pending.length === 0) return null;
    return pending.reduce((soonest, p) => (p.expiresAt < soonest.expiresAt ? p : soonest));
  }, [pending]);

  const start = useCallback(
    (input: StartUndoInput) => {
      const at = Date.now();
      const expiresAt = resolveExpiryMs(input.response, at, windowMs, allowClientOnlyWindow);
      // No server window (or latency already closed it) — do not offer an
      // undo the server would reject.
      if (expiresAt === null || expiresAt - at <= 0) return;
      setNow(at);
      setPending((prev) => [
        ...prev.filter((p) => p.proposalId !== input.proposalId),
        { proposalId: input.proposalId, summary: input.summary, expiresAt },
      ]);
    },
    [windowMs, allowClientOnlyWindow],
  );

  const drop = useCallback((proposalId: string) => {
    setPending((prev) => prev.filter((p) => p.proposalId !== proposalId));
  }, []);

  const undo = useCallback(async () => {
    const target = current;
    if (!target) return;
    if (inFlightRef.current.has(target.proposalId)) return;
    inFlightRef.current.add(target.proposalId);
    drop(target.proposalId);
    try {
      const res = await requestUndo(target.proposalId);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { message?: string })?.message ?? `HTTP ${res.status}`);
      }
      onUndone?.(target.proposalId);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'Undo failed');
    } finally {
      inFlightRef.current.delete(target.proposalId);
    }
  }, [current, drop, requestUndo, onUndone, onError]);

  const dismiss = useCallback(() => {
    if (current) drop(current.proposalId);
  }, [current, drop]);

  const remainingMs = current ? Math.max(0, current.expiresAt - now) : 0;

  return {
    proposalId: current?.proposalId ?? null,
    summary: current?.summary ?? '',
    isActive: current !== null && remainingMs > 0,
    remainingMs,
    windowMs,
    start,
    undo,
    dismiss,
  };
}
