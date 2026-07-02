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

  const refetch = useCallback(async () => {
    const myVersion = ++requestVersionRef.current;
    try {
      const body = await fetchStatusCoalesced(apiFetch);
      if (myVersion !== requestVersionRef.current) return;
      setData(body);
      setError(null);
    } catch (err) {
      if (myVersion !== requestVersionRef.current) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (myVersion === requestVersionRef.current) setIsLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    void refetch();
    if (pollIntervalMs <= 0) return;
    const id = setInterval(() => {
      void refetch();
    }, pollIntervalMs);
    return () => clearInterval(id);
  }, [refetch, pollIntervalMs, enabled]);

  return { data, isLoading, error, refetch };
}
