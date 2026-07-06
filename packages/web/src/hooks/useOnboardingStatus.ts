import { useEffect, useState, useCallback, useRef } from 'react';
import { useApiClient } from '../lib/apiClient';
import type { OnboardingStatusResponse } from '../types/onboarding';

export interface OnboardingStatusResult {
  data: OnboardingStatusResponse | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Polls GET /api/onboarding/status at a configurable interval.
 *
 * Used by:
 *   - OnboardingShell (3s while user is on /onboarding so phone-provisioning
 *     and test-call detection feel real-time)
 *   - App-shell guard (30s on every authed page so completing onboarding
 *     elsewhere correctly unblocks the rest of the app)
 */
/**
 * Module-level request coalescing. Several components mount this hook on
 * every authenticated page (the ProtectedRoute guard + the past-due /
 * upgrade / celebration banners), and ProtectedRoute remounts per
 * navigation — without coalescing, one page load fired the same
 * GET /api/onboarding/status 10+ times (QA sweep 2026-07-02). One
 * in-flight promise is shared and a response is reused within a short
 * TTL; the 3s onboarding-shell poller still sees fresh data every tick
 * because the TTL sits below its interval.
 */
const STATUS_CACHE_TTL_MS = 2000;
let inflightStatus: Promise<OnboardingStatusResponse> | null = null;
let lastStatus: { body: OnboardingStatusResponse; at: number } | null = null;

function fetchStatusCoalesced(
  apiFetch: ReturnType<typeof useApiClient>,
): Promise<OnboardingStatusResponse> {
  if (lastStatus && Date.now() - lastStatus.at < STATUS_CACHE_TTL_MS) {
    return Promise.resolve(lastStatus.body);
  }
  if (!inflightStatus) {
    inflightStatus = (async () => {
      try {
        const res = await apiFetch('/api/onboarding/status');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as OnboardingStatusResponse;
        lastStatus = { body, at: Date.now() };
        return body;
      } finally {
        inflightStatus = null;
      }
    })();
  }
  return inflightStatus;
}

/** Test-only: drop the module cache so test cases don't bleed into each other. */
export function _resetOnboardingStatusCacheForTests(): void {
  inflightStatus = null;
  lastStatus = null;
}

export function useOnboardingStatus(
  pollIntervalMs = 3000,
  enabled = true,
): OnboardingStatusResult {
  const apiFetch = useApiClient();
  const [data, setData] = useState<OnboardingStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestVersionRef = useRef(0);

  // Error backoff: the interval keeps ticking, but after consecutive
  // failures ticks are skipped until the backoff window (doubling per
  // failure, capped at 5 min) elapses. This hook is mounted by the route
  // guard on every authed page — without the backoff a persistently
  // failing endpoint (e.g. server-side auth outage) was re-hit at full
  // rate forever, each tick costing a 401 + forced-refresh retry.
  const consecutiveFailuresRef = useRef(0);
  const nextAttemptAtRef = useRef(0);
  const BACKOFF_CAP_MS = 5 * 60_000;

  const load = useCallback(
    async (force: boolean) => {
      if (!force && Date.now() < nextAttemptAtRef.current) return;
      const myVersion = ++requestVersionRef.current;
      try {
        const body = await fetchStatusCoalesced(apiFetch);
        if (myVersion !== requestVersionRef.current) return;
        consecutiveFailuresRef.current = 0;
        nextAttemptAtRef.current = 0;
        setData(body);
        setError(null);
      } catch (err) {
        if (myVersion !== requestVersionRef.current) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const failures = ++consecutiveFailuresRef.current;
        nextAttemptAtRef.current =
          Date.now() + Math.min(Math.max(pollIntervalMs, 1000) * 2 ** failures, BACKOFF_CAP_MS);
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        if (myVersion === requestVersionRef.current) setIsLoading(false);
      }
    },
    [apiFetch, pollIntervalMs],
  );

  // Public refetch bypasses the backoff window — an explicit caller action
  // (retry button, post-mutation refresh) should always hit the server.
  const refetch = useCallback(() => load(true), [load]);

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    void load(true);
    if (pollIntervalMs <= 0) return;
    const id = setInterval(() => {
      void load(false);
    }, pollIntervalMs);
    return () => clearInterval(id);
  }, [load, pollIntervalMs, enabled]);

  return { data, isLoading, error, refetch };
}
