import { useState, useEffect, useCallback, useRef } from 'react';
import { useApiClient } from '../lib/apiClient';

export interface DetailQueryResult<T> {
  data: T | null;
  /**
   * True only for cold loads (first fetch for an id, or id change). Same-id
   * `refetch()` keeps this false so detail pages don't blank to a spinner
   * after every edit.
   */
  isLoading: boolean;
  /** True whenever any fetch is in flight (including background). */
  isFetching: boolean;
  error: string | null;
  /** Background refresh for the current id — preserves last-good entity. */
  refetch: () => void;
}

/**
 * Authenticated detail-fetching hook (P0-030).
 *
 * Routes through {@link useApiClient}, which attaches the Clerk Bearer
 * token, cancels mid-sign-out requests, and bounces the user to /login
 * after a persistent 401.
 *
 * Loading semantics: clear + spinner only when the *id* changes (or on
 * first mount). Same-id refetch keeps the last-good entity mounted so
 * Job/Invoice/Estimate detail pages don't flash blank after mutations.
 */
export function useDetailQuery<T>(
  endpoint: string,
  id: string | null
): DetailQueryResult<T> {
  const apiFetch = useApiClient();
  const [data, setData] = useState<T | null>(null);
  // Loading from the first render when an id is present: initializing to
  // false made consumers paint their error/empty branch before the fetch
  // effect ran (InvoiceDetail flashed "Failed to load invoice" on every
  // open).
  const [isLoading, setIsLoading] = useState(id !== null);
  const [isFetching, setIsFetching] = useState(id !== null);
  const [error, setError] = useState<string | null>(null);
  // Monotonic request id. New fetches increment it; in-flight fetches bail
  // out before committing if a newer request has started, so an out-of-order
  // response can't overwrite the current id's data.
  const requestVersionRef = useRef(0);
  // Last id that successfully loaded — used to decide whether a fetch is
  // a same-id background refresh or a cold id swap.
  const loadedIdRef = useRef<string | null>(null);

  const fetchDetail = useCallback(
    async (opts?: { background?: boolean }) => {
      if (!id) {
        // id cleared (selection closed): drop the previous entity's state so
        // the "no selection" render doesn't show stale data or errors.
        loadedIdRef.current = null;
        setData(null);
        setError(null);
        setIsLoading(false);
        setIsFetching(false);
        return;
      }
      const myVersion = ++requestVersionRef.current;
      const background =
        opts?.background === true && loadedIdRef.current === id;
      // Cold id change: clear prior entity so we never show customer A's
      // invoice while loading customer B. Same-id background keeps it.
      if (!background) {
        setData(null);
        setIsLoading(true);
        setError(null);
      }
      setIsFetching(true);
      try {
        const response = await apiFetch(`${endpoint}/${id}`);
        if (myVersion !== requestVersionRef.current) return;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        if (myVersion !== requestVersionRef.current) return;
        loadedIdRef.current = id;
        setData(result);
        setError(null);
      } catch (err) {
        if (myVersion !== requestVersionRef.current) return;
        // AbortError indicates a deliberately cancelled request (sign-out
        // transition); we don't want to surface that as a user-facing error.
        if (err instanceof DOMException && err.name === 'AbortError') {
          if (!background) setError(null);
        } else if (background) {
          // Keep last-good entity on transient background failure.
          return;
        } else {
          loadedIdRef.current = null;
          setError(err instanceof Error ? err.message : 'Unknown error');
        }
      } finally {
        if (myVersion === requestVersionRef.current) {
          setIsFetching(false);
          if (!background) setIsLoading(false);
        }
      }
    },
    [apiFetch, endpoint, id]
  );

  // Id / endpoint changes are foreground. apiFetch identity churn alone is
  // background once this id has loaded (avoids StrictMode / token-bridge
  // flicker on detail pages).
  const detailIdentity = `${endpoint}|${id ?? ''}`;
  const lastDetailIdentityRef = useRef(detailIdentity);
  useEffect(() => {
    if (lastDetailIdentityRef.current !== detailIdentity) {
      lastDetailIdentityRef.current = detailIdentity;
      loadedIdRef.current = null;
      void fetchDetail({ background: false });
      return;
    }
    void fetchDetail({
      background: id !== null && loadedIdRef.current === id,
    });
  }, [fetchDetail, detailIdentity, id]);

  const refetch = useCallback(() => {
    void fetchDetail({ background: true });
  }, [fetchDetail]);

  return { data, isLoading, isFetching, error, refetch };
}
