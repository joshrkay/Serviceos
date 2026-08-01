import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthedFetch } from '../api/me';
import { fetchDigest, type DigestResponse } from '../api/digest';
import { useApiClient } from '../lib/useApiClient';

export interface DigestResult {
  data: DigestResponse | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Fetches GET /api/digests/:date for a digest screen. Uses the typed API client
 * with the same request-version de-dup + AbortError-as-non-error handling as
 * useDetailQuery.
 */
export function useDigest(date: string | 'latest' = 'latest'): DigestResult {
  const api = useApiClient() as AuthedFetch;
  const [data, setData] = useState<DigestResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);

  const refetch = useCallback(async () => {
    const myVersion = ++versionRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchDigest(api, date);
      if (myVersion !== versionRef.current) return;
      setData(result);
    } catch (err) {
      if (myVersion !== versionRef.current) return;
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Unknown error');
      setData(null);
    } finally {
      if (myVersion === versionRef.current) setIsLoading(false);
    }
  }, [api, date]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, isLoading, error, refetch };
}
