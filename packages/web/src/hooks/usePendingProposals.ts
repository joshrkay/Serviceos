import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiClient } from '../lib/apiClient';

export interface PendingProposalSummary {
  id: string;
  summary: string;
  proposalType: string;
  createdAt: string;
  expiresAt?: string;
}

interface ListProposalsResponse {
  data: PendingProposalSummary[];
  total: number;
}

export interface UsePendingProposalsOptions {
  /** Poll interval in ms while the tab is visible. Defaults to 30s. */
  pollIntervalMs?: number;
  /**
   * Fired once per proposal id that wasn't present in the prior poll.
   * Not fired for the first successful response — that snapshot is the
   * baseline, so mount doesn't surface a toast for every existing item.
   */
  onNewProposal?: (proposal: PendingProposalSummary) => void;
  /** Fired when an existing proposal crosses into critical urgency (expiring within 2h). */
  onCriticalProposal?: (proposal: PendingProposalSummary) => void;
  /** Skip the hook entirely (e.g., unauthenticated routes). */
  enabled?: boolean;
}

const CRITICAL_WINDOW_MS = 2 * 60 * 60 * 1000;

function isCriticalProposal(p: PendingProposalSummary): boolean {
  if (!p.expiresAt) return false;
  const ms = new Date(p.expiresAt).getTime() - Date.now();
  return ms > 0 && ms <= CRITICAL_WINDOW_MS;
}

export interface UsePendingProposalsResult {
  count: number;
  proposals: PendingProposalSummary[];
  isLoading: boolean;
  error: string | null;
  /** One-shot refetch — call after an approval/rejection to update the badge. */
  refresh: () => Promise<void>;
}

const DEFAULT_POLL_MS = 30_000;

/**
 * P2-033 — Polls `/api/proposals?status=ready_for_review` for badge
 * counts + new-proposal notifications.
 *
 * Two correctness rules drive the design:
 *
 * 1. The first response seeds a baseline of known ids — we don't toast
 *    for items that already exist. Subsequent polls diff against that
 *    set and invoke `onNewProposal` once per id that wasn't there
 *    before.
 *
 * 2. Polling pauses while `document.hidden` is true. When the tab
 *    regains focus we fire a one-shot refresh AND restart the interval
 *    so the badge is correct immediately and stays current.
 */
export function usePendingProposals(
  options: UsePendingProposalsOptions = {},
): UsePendingProposalsResult {
  const { pollIntervalMs = DEFAULT_POLL_MS, onNewProposal, onCriticalProposal, enabled = true } = options;
  const apiFetch = useApiClient();
  const [proposals, setProposals] = useState<PendingProposalSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `null` means "no baseline yet"; on the first successful response we
  // populate it and stop suppressing the toast callback.
  const knownIdsRef = useRef<Set<string> | null>(null);

  // Hold the latest onNewProposal + apiFetch in refs so the polling
  // effect doesn't tear down + restart whenever the consumer passes a
  // fresh closure or Clerk's getToken regenerates (which it does on
  // every render in some environments). Without these, every state
  // update would cancel the interval and immediately re-fire a fetch.
  const onNewProposalRef = useRef(onNewProposal);
  useEffect(() => {
    onNewProposalRef.current = onNewProposal;
  }, [onNewProposal]);

  const onCriticalProposalRef = useRef(onCriticalProposal);
  useEffect(() => {
    onCriticalProposalRef.current = onCriticalProposal;
  }, [onCriticalProposal]);

  const wasCriticalRef = useRef<Set<string>>(new Set());

  const apiFetchRef = useRef(apiFetch);
  useEffect(() => {
    apiFetchRef.current = apiFetch;
  }, [apiFetch]);

  const fetchOnce = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiFetchRef.current('/api/proposals?status=ready_for_review&limit=100');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as ListProposalsResponse & {
        data?: Array<PendingProposalSummary & { expiresAt?: string | Date }>;
      };
      const list: PendingProposalSummary[] = (body.data ?? []).map((p) => ({
        id: p.id,
        summary: p.summary,
        proposalType: p.proposalType,
        createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date(p.createdAt).toISOString(),
        expiresAt: p.expiresAt
          ? typeof p.expiresAt === 'string'
            ? p.expiresAt
            : new Date(p.expiresAt).toISOString()
          : undefined,
      }));

      const previous = knownIdsRef.current;
      if (previous !== null) {
        for (const p of list) {
          if (!previous.has(p.id)) {
            onNewProposalRef.current?.(p);
          }
          const critical = isCriticalProposal(p);
          if (critical && !wasCriticalRef.current.has(p.id)) {
            onCriticalProposalRef.current?.(p);
          }
          if (critical) {
            wasCriticalRef.current.add(p.id);
          }
        }
      } else {
        for (const p of list) {
          if (isCriticalProposal(p)) {
            wasCriticalRef.current.add(p.id);
          }
        }
      }
      knownIdsRef.current = new Set(list.map((p) => p.id));
      setProposals(list);
    } catch (err) {
      // Mid sign-out the api client throws an AbortError. That's not a
      // user-visible failure — swallow it and let the next render
      // retry once auth settles.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (intervalId !== null) return;
      intervalId = setInterval(() => {
        void fetchOnce();
      }, pollIntervalMs);
    };
    const stop = () => {
      if (intervalId === null) return;
      clearInterval(intervalId);
      intervalId = null;
    };

    void fetchOnce();
    if (typeof document === 'undefined' || !document.hidden) {
      start();
    }

    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        void fetchOnce();
        start();
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    return () => {
      stop();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [enabled, fetchOnce, pollIntervalMs]);

  return {
    count: proposals.length,
    proposals,
    isLoading,
    error,
    refresh: fetchOnce,
  };
}
