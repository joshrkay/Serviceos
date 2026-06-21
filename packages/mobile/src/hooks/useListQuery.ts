import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApiClient } from '../lib/useApiClient';
import { decodeError } from '../lib/appError';

export interface ListQueryOptions {
  enabled?: boolean;
  /** Appended as query string (e.g. `{ status: 'open' }`). */
  params?: Record<string, string>;
}

export interface ListQueryResult<T> {
  data: T[];
  total: number;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Small RN port of web's useListQuery. Fetches a list endpoint, normalizing
 * either `{ data, total }` or a bare array. A monotonic request version drops
 * out-of-order/superseded responses (e.g. a route change reusing the
 * component), and an AbortError (sign-out mid-flight) is treated as a non-error.
 */
export function useListQuery<T>(endpoint: string, options: ListQueryOptions = {}): ListQueryResult<T> {
  const api = useApiClient();
  const [data, setData] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);

  const enabled = options.enabled ?? true;
  // Stable key so an inline params object doesn't refetch every render.
  const paramsKey = JSON.stringify(options.params ?? {});
  const url = useMemo(() => {
    const params = new URLSearchParams(JSON.parse(paramsKey) as Record<string, string>);
    const qs = params.toString();
    return qs ? `${endpoint}?${qs}` : endpoint;
  }, [endpoint, paramsKey]);

  const refetch = useCallback(async () => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    const myVersion = ++versionRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const res = await api(url);
      if (myVersion !== versionRef.current) return;
      if (!res.ok) throw new Error((await decodeError(res)).message);
      const result = (await res.json()) as { data?: T[]; total?: number } | T[];
      if (myVersion !== versionRef.current) return;
      const list = (Array.isArray(result) ? result : (result.data ?? [])) as T[];
      setData(list);
      setTotal(!Array.isArray(result) && typeof result.total === 'number' ? result.total : list.length);
    } catch (err) {
      if (myVersion !== versionRef.current) return;
      if (err instanceof Error && err.name === 'AbortError') return; // cancelled on sign-out
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (myVersion === versionRef.current) setIsLoading(false);
    }
  }, [api, url, enabled]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, total, isLoading, error, refetch };
}
