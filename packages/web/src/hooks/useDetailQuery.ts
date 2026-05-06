import { useState, useEffect, useCallback } from 'react';
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

  const refetch = useCallback(async () => {
    if (!id) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await apiFetch(`${endpoint}/${id}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      setData(result);
    } catch (err) {
      // AbortError indicates a deliberately cancelled request (sign-out
      // transition); we don't want to surface that as a user-facing error.
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : 'Unknown error');
      }
    } finally {
      setIsLoading(false);
    }
  }, [apiFetch, endpoint, id]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, isLoading, error, refetch };
}
