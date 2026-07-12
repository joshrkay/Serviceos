import { vi } from 'vitest';
import type { ListQueryResult } from '../hooks/useListQuery';

/**
 * Builds a default ListQueryResult shape for mocking useListQuery in tests.
 *
 * The hook's public surface is { data, total, page, pageSize, isLoading,
 * error, refetch, setPage, setSearch, setFilters }; tests rarely need
 * anything but `data`, so this helper fills in stable defaults for the rest.
 */
// Explicit return type: pins the portable `ListQueryResult<T>` name so the
// declaration does not try to reference vitest's nested `@vitest/spy` Mock type
// (TS2742 under vitest 4's hoisting), and contextually types the `vi.fn()`
// fillers to the concrete callback signatures.
export function listQueryResult<T>(data: T[]): ListQueryResult<T> {
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
