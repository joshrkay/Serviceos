import { useState, useEffect, useCallback, useRef } from 'react';
import { useApiClient } from '../lib/apiClient';

export interface ListQueryOptions {
  search?: string;
  filters?: Record<string, string>;
  enabled?: boolean;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  /**
   * Epic 12.2 — when set, re-fetch on this interval (ms) so a surface like
   * the HomePage "today" snapshot updates live. Polling pauses while the tab
   * is hidden and fires a one-shot catch-up refetch on refocus, so a
   * backgrounded tab doesn't burn requests. Omit (the default) for the
   * original fetch-once-per-change behavior.
   *
   * Interval / visibility catch-up refetches are always *background*: they
   * keep the last-good rows mounted and never flip `isLoading` (which would
   * flash spinners on Home / Invoices every poll tick).
   */
  refetchInterval?: number;
}

export interface ListQueryResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  /**
   * True only for cold / structural loads (first fetch, page/search/filter
   * change, or enable). Background polls and explicit `refetch()` keep this
   * false so consumers can leave last-good content on screen.
   */
  isLoading: boolean;
  /** True whenever any fetch is in flight (including background). */
  isFetching: boolean;
  error: string | null;
  /** Background refresh — preserves mounted rows. */
  refetch: () => void;
  setPage: (page: number) => void;
  setSearch: (search: string) => void;
  setFilters: (filters: Record<string, string>) => void;
}

/**
 * Authenticated list-fetching hook (P0-030).
 *
 * Every request flows through {@link useApiClient}, which injects the Clerk
 * Bearer token, cancels unauthenticated requests, and redirects to /login
 * on a persistent 401. Loading semantics mirror {@link useDispatchBoard}:
 * structural changes (page/search/filters) are foreground; polls and
 * explicit `refetch()` are background so live surfaces don't flicker.
 */
export function useListQuery<T>(
  endpoint: string,
  initialOptions: ListQueryOptions = {}
): ListQueryResult<T> {
  const apiFetch = useApiClient();
  const [data, setData] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(initialOptions.page ?? 1);
  const [pageSize] = useState(initialOptions.pageSize ?? 25);
  const [search, setSearch] = useState(initialOptions.search ?? '');
  const [filters, setFilters] = useState(initialOptions.filters ?? {});
  const [enabled, setEnabled] = useState(initialOptions.enabled ?? true);
  // Start in loading state when a fetch is imminent: initializing to false
  // made every list page paint its empty state ("No customers found") for
  // the frame(s) before the first request even fired.
  const [isLoading, setIsLoading] = useState(initialOptions.enabled !== false);
  const [isFetching, setIsFetching] = useState(initialOptions.enabled !== false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync filters / enabled from props when the caller's initialOptions
  // change. The hook holds these in state so consumers can drive them via
  // setFilters/setSearch, but a route change (e.g. /customers/A →
  // /customers/B reusing the same component instance) needs to rebind the
  // query — without this, useState would keep the previous customerId and
  // the next render shows the wrong customer's data. We compare a
  // serialized key so inline-object filters with the same value don't
  // trigger a spurious extra fetch on mount.
  const filtersKey = JSON.stringify(initialOptions.filters ?? {});
  const lastFiltersKeyRef = useRef(filtersKey);
  useEffect(() => {
    if (lastFiltersKeyRef.current === filtersKey) return;
    lastFiltersKeyRef.current = filtersKey;
    setFilters(initialOptions.filters ?? {});
    // The parsed object is read via closure; depending on filtersKey is the
    // intentional stable comparison.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);
  useEffect(() => {
    if (typeof initialOptions.enabled === 'boolean') {
      setEnabled(initialOptions.enabled);
    }
  }, [initialOptions.enabled]);

  // Monotonic request id. Each new fetch increments it; in-flight fetches
  // check the current ref before committing to state and bail out if they
  // were superseded. Without this, two requests fired in the same render
  // tick (e.g. one with stale filters before the resync effect lands and
  // one with the new filters) can resolve out of order and let the older
  // response overwrite the newer data.
  const requestVersionRef = useRef(0);
  // Tracks whether a successful list payload has landed. Background
  // treatment (keep rows mounted, suppress loading/error flash) is only
  // safe once there's a last-good snapshot to keep showing.
  const hasLoadedRef = useRef(false);

  const fetchList = useCallback(
    async (opts?: { background?: boolean }) => {
      if (!enabled) {
        setIsLoading(false);
        setIsFetching(false);
        return;
      }
      const myVersion = ++requestVersionRef.current;
      const background = opts?.background === true && hasLoadedRef.current;
      if (!background) setIsLoading(true);
      setIsFetching(true);
      if (!background) setError(null);
      try {
        const params = new URLSearchParams({
          page: String(page),
          pageSize: String(pageSize),
          ...(search ? { search } : {}),
          ...filters,
        });
        const response = await apiFetch(`${endpoint}?${params}`);
        if (myVersion !== requestVersionRef.current) return;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        if (myVersion !== requestVersionRef.current) return;
        hasLoadedRef.current = true;
        setData(result.data ?? result);
        setTotal(result.total ?? result.length ?? 0);
        setError(null);
      } catch (err) {
        if (myVersion !== requestVersionRef.current) return;
        // Sign-out transitions surface as AbortError — treat as a non-error
        // (the request was deliberately cancelled). Real errors still surface
        // on foreground loads; background failures keep last-good rows.
        if (err instanceof DOMException && err.name === 'AbortError') {
          if (!background) setError(null);
        } else if (background) {
          return;
        } else {
          setError(err instanceof Error ? err.message : 'Unknown error');
        }
      } finally {
        if (myVersion === requestVersionRef.current) {
          setIsFetching(false);
          if (!background) setIsLoading(false);
        }
      }
    },
    [apiFetch, enabled, endpoint, page, pageSize, search, filters]
  );

  // Structural changes (page / search / filters / endpoint / enable) are
  // foreground so the consumer can show a spinner for a genuine new query.
  // When only `apiFetch` identity changes (Clerk token bridge), keep the
  // last-good rows mounted — a foreground flash there was a common source
  // of Home/list flicker under StrictMode / auth re-renders.
  const queryIdentity = `${endpoint}|${page}|${pageSize}|${search}|${JSON.stringify(filters)}|${enabled}`;
  const lastQueryIdentityRef = useRef(queryIdentity);
  useEffect(() => {
    if (lastQueryIdentityRef.current !== queryIdentity) {
      lastQueryIdentityRef.current = queryIdentity;
      // New query shape — next fetch is cold even if a prior list existed.
      hasLoadedRef.current = false;
      void fetchList({ background: false });
      return;
    }
    void fetchList({ background: hasLoadedRef.current });
  }, [fetchList, queryIdentity]);

  // Explicit refetch is always background once a list has loaded — used by
  // pollers, post-mutation refresh, and visibility catch-up.
  const refetch = useCallback(() => {
    void fetchList({ background: true });
  }, [fetchList]);

  // Epic 12.2 — optional live polling. Held in a ref so the interval doesn't
  // tear down and re-fire on every refetch identity change; pauses while the
  // tab is hidden and catches up on refocus (mirrors usePendingProposals).
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  const refetchInterval = initialOptions.refetchInterval;
  useEffect(() => {
    if (!enabled || !refetchInterval || refetchInterval <= 0) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (intervalId !== null) return;
      intervalId = setInterval(() => void refetchRef.current(), refetchInterval);
    };
    const stop = () => {
      if (intervalId === null) return;
      clearInterval(intervalId);
      intervalId = null;
    };

    if (typeof document === 'undefined' || !document.hidden) start();

    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        void refetchRef.current();
        start();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    return () => {
      stop();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [enabled, refetchInterval]);

  // Searching or filtering while on page > 1 must snap back to page 1:
  // keeping the old page number requests a stale slice of the new result
  // set and typically renders a wrong empty state even when matches exist.
  const setSearchAndResetPage = useCallback((next: string) => {
    setSearch(next);
    setPage(1);
  }, []);
  const setFiltersAndResetPage = useCallback((next: Record<string, string>) => {
    setFilters(next);
    setPage(1);
  }, []);

  return {
    data,
    total,
    page,
    pageSize,
    isLoading,
    isFetching,
    error,
    refetch,
    setPage,
    setSearch: setSearchAndResetPage,
    setFilters: setFiltersAndResetPage,
  };
}
