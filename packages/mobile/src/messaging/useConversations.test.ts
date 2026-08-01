// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));

// eslint-disable-next-line import/first
import { useConversations } from './useConversations';

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

const thread = (over: Record<string, unknown> = {}) => ({
  conversation: { id: 'c1', entityType: 'customer', entityId: 'cust-1', status: 'open' },
  lastMessageAt: '2026-06-20T10:00:00Z',
  lastMessagePreview: 'My AC is out',
  lastMessageDirection: 'inbound',
  needsReply: true,
  messageCount: 1,
  customerName: 'Acme',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('useConversations', () => {
  it('loads threads from the { threads } envelope and counts needs-reply', async () => {
    h.api.mockResolvedValue(
      ok({ threads: [thread(), thread({ needsReply: false, lastMessageDirection: 'outbound' })] }),
    );
    const { result } = renderHook(() => useConversations({ pollIntervalMs: 1_000_000 }));
    await waitFor(() => expect(result.current.threads).toHaveLength(2));
    expect(result.current.needsReplyCount).toBe(1);
    expect(h.api).toHaveBeenCalledWith('/api/conversations');
  });

  it('treats a missing threads field as empty', async () => {
    h.api.mockResolvedValue(ok({}));
    const { result } = renderHook(() => useConversations({ pollIntervalMs: 1_000_000 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.threads).toEqual([]);
  });

  it('surfaces a non-ok response as an error', async () => {
    h.api.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const { result } = renderHook(() => useConversations({ pollIntervalMs: 1_000_000 }));
    await waitFor(() => expect(result.current.error).toBe('HTTP 500'));
  });

  it('treats an AbortError as a non-error (sign-out mid-flight)', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    h.api.mockRejectedValue(abort);
    const { result } = renderHook(() => useConversations({ pollIntervalMs: 1_000_000 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
  });
});
