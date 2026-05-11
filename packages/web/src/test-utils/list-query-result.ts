import { vi } from 'vitest';

/**
 * Builds a default ListQueryResult shape for mocking useListQuery in tests.
 *
 * The hook's public surface is { data, total, page, pageSize, isLoading,
 * error, refetch, setPage, setSearch, setFilters }; tests rarely need
 * anything but `data`, so this helper fills in stable defaults for the rest.
 */
export function listQueryResult<T>(data: T[]) {
  return {
    data,
    total: data.length,
    page: 1,
    pageSize: 25,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    setPage: vi.fn(),
    setSearch: vi.fn(),
    setFilters: vi.fn(),
  };
}
