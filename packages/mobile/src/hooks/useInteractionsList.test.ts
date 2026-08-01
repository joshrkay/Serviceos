// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));

// eslint-disable-next-line import/first
import { useInteractionsList } from './useInteractionsList';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('useInteractionsList', () => {
  it('loads interactions and exposes rows', async () => {
    h.api.mockResolvedValue(
      jsonResponse({
        data: [{ id: 'int-1', channel: 'voice_inbound', transcriptTurnCount: 2 }],
        total: 1,
        limit: 20,
        offset: 0,
      }),
    );
    const { result } = renderHook(() => useInteractionsList());
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.total).toBe(1);
    expect(h.api).toHaveBeenCalledWith('/api/interactions');
  });

  it('appends limit, offset, and customerId query params', async () => {
    h.api.mockResolvedValue(jsonResponse({ data: [], total: 0, limit: 10, offset: 5 }));
    renderHook(() => useInteractionsList({ limit: 10, offset: 5, customerId: 'cust-1' }));
    await waitFor(() =>
      expect(h.api).toHaveBeenCalledWith('/api/interactions?limit=10&offset=5&customerId=cust-1'),
    );
  });

  it('drops a superseded (out-of-order) response', async () => {
    const resolvers: Array<(r: unknown) => void> = [];
    h.api.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const { result } = renderHook(() => useInteractionsList());

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      void result.current.refetch();
      await Promise.resolve();
    });
    expect(resolvers).toHaveLength(2);

    await act(async () => {
      resolvers[1]!(
        jsonResponse({ data: [{ id: 'B', transcriptTurnCount: 0 }], total: 1, limit: 20, offset: 0 }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      resolvers[0]!(
        jsonResponse({ data: [{ id: 'A', transcriptTurnCount: 0 }], total: 1, limit: 20, offset: 0 }),
      );
      await Promise.resolve();
    });

    expect(result.current.data).toEqual([{ id: 'B', transcriptTurnCount: 0 }]);
  });

  it('treats an AbortError as a non-error', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    h.api.mockRejectedValue(abort);
    const { result } = renderHook(() => useInteractionsList());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
  });

  it('surfaces the backend error message on failure', async () => {
    h.api.mockResolvedValue(new Response(null, { status: 500, statusText: 'Server Error' }));
    const { result } = renderHook(() => useInteractionsList());
    await waitFor(() => expect(result.current.error).toMatch(/listInteractions: 500/));
  });

  it('does not fetch when disabled', async () => {
    h.api.mockResolvedValue(jsonResponse({ data: [], total: 0, limit: 20, offset: 0 }));
    renderHook(() => useInteractionsList({ enabled: false }));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.api).not.toHaveBeenCalled();
  });
});
