import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../utils/api-fetch';

export interface ListQueryOptions {
  search?: string;
  filters?: Record<string, string>;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface ListQueryResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
  setPage: (page: number) => void;
  setSearch: (search: string) => void;
  setFilters: (filters: Record<string, string>) => void;
}

export function useListQuery<T>(
  endpoint: string,
  initialOptions: ListQueryOptions = {}
): ListQueryResult<T> {
  const [data, setData] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(initialOptions.page ?? 1);
  const [pageSize] = useState(initialOptions.pageSize ?? 25);
  const [search, setSearch] = useState(initialOptions.search ?? '');
  const [filters, setFilters] = useState(initialOptions.filters ?? {});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(search ? { search } : {}),
        ...filters,
      });
      const response = await apiFetch(`${endpoint}?${params}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      setData(result.data ?? result);
      setTotal(result.total ?? result.length ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, [endpoint, page, pageSize, search, filters]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, total, page, pageSize, isLoading, error, refetch, setPage, setSearch, setFilters };
}
