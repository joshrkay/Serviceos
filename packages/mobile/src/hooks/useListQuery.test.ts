// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));

// eslint-disable-next-line import/first
import { useListQuery } from './useListQuery';

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('useListQuery', () => {
  it('loads { data, total } and exposes rows', async () => {
    h.api.mockResolvedValue(ok({ data: [{ id: 'a' }, { id: 'b' }], total: 2 }));
    const { result } = renderHook(() => useListQuery<{ id: string }>('/api/customers'));
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(result.current.total).toBe(2);
    expect(h.api).toHaveBeenCalledWith('/api/customers');
  });

  it('normalizes a bare array response (total = length)', async () => {
    h.api.mockResolvedValue(ok([{ id: 'a' }]));
    const { result } = renderHook(() => useListQuery('/api/jobs'));
    await waitFor(() => expect(result.current.total).toBe(1));
  });

  it('appends params to the query string', async () => {
    h.api.mockResolvedValue(ok({ data: [], total: 0 }));
    renderHook(() => useListQuery('/api/invoices', { params: { status: 'open' } }));
    await waitFor(() => expect(h.api).toHaveBeenCalledWith('/api/invoices?status=open'));
  });

  it('drops a superseded (out-of-order) response', async () => {
    const resolvers: Array<(r: unknown) => void> = [];
    h.api.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const { result } = renderHook(() => useListQuery<{ id: string }>('/api/customers'));

    await act(async () => {
      await Promise.resolve(); // mount load in flight (resolvers[0])
    });
    await act(async () => {
      void result.current.refetch(); // second load (resolvers[1])
      await Promise.resolve();
    });
    expect(resolvers).toHaveLength(2);

    // Newer (B) resolves first, then the stale older (A) resolves last.
    await act(async () => {
      resolvers[1](ok({ data: [{ id: 'B' }], total: 1 }));
      await Promise.resolve();
    });
    await act(async () => {
      resolvers[0](ok({ data: [{ id: 'A' }], total: 1 }));
      await Promise.resolve();
    });

    expect(result.current.data).toEqual([{ id: 'B' }]);
  });

  it('treats an AbortError as a non-error (sign-out mid-flight)', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    h.api.mockRejectedValue(abort);
    const { result } = renderHook(() => useListQuery('/api/customers'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
  });

  it('surfaces a non-ok response as an error', async () => {
    h.api.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const { result } = renderHook(() => useListQuery('/api/customers'));
    await waitFor(() => expect(result.current.error).toBe('HTTP 500'));
  });

  it('does not fetch when disabled', async () => {
    h.api.mockResolvedValue(ok({ data: [], total: 0 }));
    renderHook(() => useListQuery('/api/customers', { enabled: false }));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.api).not.toHaveBeenCalled();
  });
});
