import { useState, useEffect, useCallback, useRef } from 'react';
import { useApiClient } from '../lib/apiClient';

export interface DetailQueryResult<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Authenticated detail-fetching hook (P0-030).
 *
 * Routes through {@link useApiClient}, which attaches the Clerk Bearer
 * token, cancels mid-sign-out requests, and bounces the user to /login
 * after a persistent 401. The public surface
 * (`{ data, isLoading, error, refetch }`) is unchanged.
 */
export function useDetailQuery<T>(
  endpoint: string,
  id: string | null
): DetailQueryResult<T> {
  const apiFetch = useApiClient();
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic request id. New fetches increment it; in-flight fetches bail
  // out before committing if a newer request has started, so an out-of-order
  // response can't overwrite the current id's data.
  const requestVersionRef = useRef(0);

  const refetch = useCallback(async () => {
    if (!id) return;
    // Clear any previously-loaded entity so the consumer doesn't keep
    // rendering the prior id's data while the new fetch is in flight (and
    // so a 404 on the new id surfaces as not-found instead of leaving the
    // last-good detail on screen).
    setData(null);
    const myVersion = ++requestVersionRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const response = await apiFetch(`${endpoint}/${id}`);
      if (myVersion !== requestVersionRef.current) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (myVersion !== requestVersionRef.current) return;
      setData(result);
    } catch (err) {
      if (myVersion !== requestVersionRef.current) return;
      // AbortError indicates a deliberately cancelled request (sign-out
      // transition); we don't want to surface that as a user-facing error.
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : 'Unknown error');
      }
    } finally {
      if (myVersion === requestVersionRef.current) setIsLoading(false);
    }
  }, [apiFetch, endpoint, id]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, isLoading, error, refetch };
}
