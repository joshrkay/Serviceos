import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthedFetch } from '../api/me';
import { listInteractions, type InteractionSummary } from '../api/interactions';
import { useApiClient } from '../lib/useApiClient';

export interface InteractionsListResult {
  data: InteractionSummary[];
  total: number;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Fetches GET /api/interactions for the call log. Uses the typed API client
 * with the same request-version de-dup + AbortError-as-non-error handling as
 * useListQuery.
 */
export function useInteractionsList(
  options: { enabled?: boolean; limit?: number; offset?: number; customerId?: string } = {},
): InteractionsListResult {
  const { enabled = true, limit, offset, customerId } = options;
  const api = useApiClient() as AuthedFetch;
  const [data, setData] = useState<InteractionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);

  const refetch = useCallback(async () => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    const myVersion = ++versionRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await listInteractions(api, { limit, offset, customerId });
      if (myVersion !== versionRef.current) return;
      setData(result.data);
      setTotal(result.total);
    } catch (err) {
      if (myVersion !== versionRef.current) return;
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (myVersion === versionRef.current) setIsLoading(false);
    }
  }, [api, enabled, limit, offset, customerId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, total, isLoading, error, refetch };
}
