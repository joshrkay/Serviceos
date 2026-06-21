import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiClient } from '../lib/useApiClient';
import { decodeError } from '../lib/appError';

export interface DetailQueryResult<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Single-entity sibling of useListQuery. Fetches `endpoint` (skipped when null),
 * normalizing `{ data }` or a bare object, with the same request-version
 * de-dup + AbortError-as-non-error handling.
 */
export function useDetailQuery<T>(
  endpoint: string | null,
  options: { enabled?: boolean } = {},
): DetailQueryResult<T> {
  const api = useApiClient();
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);

  const enabled = (options.enabled ?? true) && Boolean(endpoint);

  const refetch = useCallback(async () => {
    if (!enabled || !endpoint) {
      setIsLoading(false);
      return;
    }
    const myVersion = ++versionRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const res = await api(endpoint);
      if (myVersion !== versionRef.current) return;
      if (!res.ok) throw new Error((await decodeError(res)).message);
      const result = (await res.json()) as { data?: T } | T;
      if (myVersion !== versionRef.current) return;
      const value =
        result && typeof result === 'object' && 'data' in result
          ? ((result as { data?: T }).data ?? null)
          : (result as T);
      setData(value);
    } catch (err) {
      if (myVersion !== versionRef.current) return;
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (myVersion === versionRef.current) setIsLoading(false);
    }
  }, [api, endpoint, enabled]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, isLoading, error, refetch };
}
