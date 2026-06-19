import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useApiClient } from '../lib/useApiClient';
import {
  computeProposalEvents,
  mapInboxResponse,
  type PendingProposalSummary,
} from '../proposals/proposalEvents';

export type { PendingProposalSummary };

export interface UsePendingProposalsOptions {
  /** Poll interval while the app is foregrounded. Defaults to 30s. */
  pollIntervalMs?: number;
  /** Fired once per proposal id newly present vs. the prior poll (not on baseline). */
  onNewProposal?: (p: PendingProposalSummary) => void;
  /** Fired when a proposal crosses into the 2h critical window. */
  onCriticalProposal?: (p: PendingProposalSummary) => void;
  enabled?: boolean;
}

export interface UsePendingProposalsResult {
  count: number;
  proposals: PendingProposalSummary[];
  isLoading: boolean;
  error: string | null;
  /** One-shot refetch — call after an approval to update the list/badge. */
  refresh: () => Promise<void>;
}

const DEFAULT_POLL_MS = 30_000;

/**
 * Polls GET /api/proposals/inbox for the approvals list + badge. The inbox
 * endpoint merges 'draft' + 'ready_for_review' server-side, so voice-created
 * drafts and chained dependents (which stay 'draft' while awaiting action)
 * are surfaced — a 'ready_for_review'-only poll would hide them. RN port of
 * web's usePendingProposals: pauses when the app backgrounds (AppState) and
 * one-shot-refreshes on foreground; the baseline/diff logic lives in the
 * tested proposalEvents module.
 */
export function usePendingProposals(
  options: UsePendingProposalsOptions = {},
): UsePendingProposalsResult {
  const {
    pollIntervalMs = DEFAULT_POLL_MS,
    onNewProposal,
    onCriticalProposal,
    enabled = true,
  } = options;
  const api = useApiClient();
  const [proposals, setProposals] = useState<PendingProposalSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const knownIdsRef = useRef<Set<string> | null>(null);
  const criticalIdsRef = useRef<Set<string>>(new Set());
  // Hold callbacks/client in refs so the poll effect doesn't tear down when a
  // consumer passes a fresh closure or Clerk regenerates getToken each render.
  const onNewRef = useRef(onNewProposal);
  const onCritRef = useRef(onCriticalProposal);
  const apiRef = useRef(api);
  useEffect(() => {
    onNewRef.current = onNewProposal;
  }, [onNewProposal]);
  useEffect(() => {
    onCritRef.current = onCriticalProposal;
  }, [onCriticalProposal]);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  const fetchOnce = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiRef.current('/api/proposals/inbox');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = mapInboxResponse(await res.json());
      const diff = computeProposalEvents(knownIdsRef.current, criticalIdsRef.current, list);
      knownIdsRef.current = diff.nextIds;
      criticalIdsRef.current = diff.nextCritical;
      for (const np of diff.newProposals) onNewRef.current?.(np);
      for (const cp of diff.criticalProposals) onCritRef.current?.(cp);
      setProposals(list);
    } catch (err) {
      // Mid sign-out the api client throws an AbortError — not user-visible.
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (intervalId === null) intervalId = setInterval(() => void fetchOnce(), pollIntervalMs);
    };
    const stop = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    void fetchOnce();
    if (AppState.currentState === 'active') start();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void fetchOnce();
        start();
      } else {
        stop();
      }
    });

    return () => {
      stop();
      sub.remove();
    };
  }, [enabled, fetchOnce, pollIntervalMs]);

  return { count: proposals.length, proposals, isLoading, error, refresh: fetchOnce };
}
