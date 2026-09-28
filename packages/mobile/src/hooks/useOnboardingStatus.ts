/**
 * Mobile port of the web onboarding-status gate (`packages/web/src/hooks/
 * useOnboardingStatus.ts` + the `OnboardingGuard` in `ProtectedRoute`). The
 * root layout's AuthGate consumes this: once the status is known and the
 * `identity` step isn't done, the gate routes the owner to `/onboarding`
 * instead of the CRM.
 *
 * Fail-open by design: while the status is unknown (still loading, or the
 * fetch failed) `isSetupComplete` is null and the gate must not redirect —
 * blocking the whole app on a status fetch (or a status outage) would be
 * worse than a mistimed redirect.
 *
 * Differences from web, deliberate:
 * - No interval polling. The gate re-fetches (TTL-guarded) whenever the
 *   route changes, so finishing onboarding in the voice tab unlocks the CRM
 *   without an app restart and without a background poll draining battery.
 * - Session-scoped skip: the onboarding screen's "Skip for now" is an
 *   explicit deferral. The gate must not trap the owner in a
 *   skip -> bounce-back loop, so a skip is honored for the rest of the
 *   session (per Clerk user id). A cold start re-arms the gate.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiClient } from '../lib/useApiClient';
import {
  fetchOnboardingStatus,
  isIdentityStepDone,
  type OnboardingStatusResponse,
} from '../api/onboarding';

export interface UseOnboardingStatusResult {
  /** Raw status payload; null until the first successful fetch. */
  status: OnboardingStatusResponse | null;
  isLoading: boolean;
  error: Error | null;
  /**
   * Tri-state setup verdict. `true`/`false` once the status is known;
   * `null` while loading or when the fetch failed — the gate treats null as
   * "don't redirect" (fail open).
   */
  isSetupComplete: boolean | null;
  /** Refresh the status, TTL-guarded (cheap enough to call on navigation). */
  refetch: () => Promise<void>;
}

/** Minimum gap between server hits; keeps route-change refetches cheap. */
const REFETCH_TTL_MS = 10_000;
let lastFetchAt = 0;

/** Test-only: drop the module fetch timestamp so cases don't bleed. */
export function _resetOnboardingStatusFetchForTests(): void {
  lastFetchAt = 0;
}

// --- session-scoped skip ---------------------------------------------------
const skippedUserIds = new Set<string>();

/**
 * Record an explicit "Skip for now" so the gate stops redirecting this user
 * to onboarding for the rest of the session.
 */
export function skipSetupGateForSession(
  userId: string | null | undefined,
): void {
  if (userId) skippedUserIds.add(userId);
}

/** Whether this user explicitly skipped onboarding this session. */
export function isSetupGateSkippedForSession(
  userId: string | null | undefined,
): boolean {
  return !!userId && skippedUserIds.has(userId);
}

/** Test-only: drop the skip set so cases don't bleed into each other. */
export function _resetSetupGateSkipForTests(): void {
  skippedUserIds.clear();
}
// ---------------------------------------------------------------------------

export function useOnboardingStatus(
  enabled: boolean,
): UseOnboardingStatusResult {
  const apiFetch = useApiClient();
  const [status, setStatus] = useState<OnboardingStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(
    async (force: boolean) => {
      if (!force && Date.now() - lastFetchAt < REFETCH_TTL_MS) return;
      const myRequest = ++requestIdRef.current;
      lastFetchAt = Date.now();
      setIsLoading(true);
      try {
        const body = await fetchOnboardingStatus(apiFetch);
        if (requestIdRef.current !== myRequest) return;
        setStatus(body);
        setError(null);
      } catch (err) {
        if (requestIdRef.current !== myRequest) return;
        // Fail open: a status outage must not hard-block the product.
        setError(err instanceof Error ? err : new Error('Unknown error'));
      } finally {
        if (requestIdRef.current === myRequest) setIsLoading(false);
      }
    },
    [apiFetch],
  );

  const refetch = useCallback(() => load(false), [load]);

  useEffect(() => {
    if (!enabled) return;
    void load(true);
  }, [enabled, load]);

  return {
    status,
    isLoading,
    error,
    isSetupComplete: status ? isIdentityStepDone(status) : null,
    refetch,
  };
}
