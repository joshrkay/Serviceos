// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));

// eslint-disable-next-line import/first
import { useConversationThread } from './useConversationThread';

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('useConversationThread', () => {
  it('loads the conversation messages', async () => {
    h.api.mockResolvedValue(
      ok([{ id: 'm1', conversationId: 'c1', messageType: 'text', content: 'Hi', senderId: 'cust', senderRole: 'customer', createdAt: 't' }]),
    );
    const { result } = renderHook(() => useConversationThread('c1', { pollIntervalMs: 1_000_000 }));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(h.api).toHaveBeenCalledWith('/api/conversations/c1/messages');
  });

  it('does not fetch when the id is null', async () => {
    renderHook(() => useConversationThread(null));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.api).not.toHaveBeenCalled();
  });

  it('surfaces the backend error message on a non-ok response', async () => {
    h.api.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'NOT_FOUND', message: 'Conversation not found: c1' }),
    });
    const { result } = renderHook(() => useConversationThread('c1', { pollIntervalMs: 1_000_000 }));
    await waitFor(() => expect(result.current.error).toBe('Conversation not found: c1'));
  });
});
