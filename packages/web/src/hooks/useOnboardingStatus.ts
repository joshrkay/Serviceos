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
      const res = await apiFetch('/api/onboarding/status');
      if (myVersion !== requestVersionRef.current) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as OnboardingStatusResponse;
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
