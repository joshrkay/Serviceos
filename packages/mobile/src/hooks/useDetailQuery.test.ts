// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));

// eslint-disable-next-line import/first
import { useDetailQuery } from './useDetailQuery';

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('useDetailQuery', () => {
  it('loads a bare object', async () => {
    h.api.mockResolvedValue(ok({ id: 'c1', name: 'Acme' }));
    const { result } = renderHook(() => useDetailQuery<{ id: string; name: string }>('/api/customers/c1'));
    await waitFor(() => expect(result.current.data?.name).toBe('Acme'));
    expect(h.api).toHaveBeenCalledWith('/api/customers/c1');
  });

  it('unwraps a { data } envelope', async () => {
    h.api.mockResolvedValue(ok({ data: { id: 'c1', name: 'Wrapped' } }));
    const { result } = renderHook(() => useDetailQuery<{ name: string }>('/api/customers/c1'));
    await waitFor(() => expect(result.current.data?.name).toBe('Wrapped'));
  });

  it('skips fetching when the endpoint is null', async () => {
    renderHook(() => useDetailQuery(null));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.api).not.toHaveBeenCalled();
  });

  it('surfaces the backend error message on a non-ok response', async () => {
    h.api.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'NOT_FOUND', message: 'Customer not found: missing' }),
    });
    const { result } = renderHook(() => useDetailQuery('/api/customers/missing'));
    await waitFor(() => expect(result.current.error).toBe('Customer not found: missing'));
  });
});
