import { describe, expect, it, vi } from 'vitest';
import { sendReply } from './sendReply';
import { startCustomerConversation } from './startCustomerConversation';
import type { ApiFetch } from '../lib/apiFetch';

const asApi = (fn: ReturnType<typeof vi.fn>) => fn as unknown as ApiFetch;

describe('sendReply', () => {
  it('POSTs the body and returns the threaded message', async () => {
    const api = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ message: { id: 'm9', conversationId: 'c1', content: 'On my way' } }),
    });
    const msg = await sendReply(asApi(api), 'c1', 'On my way');
    expect(msg.id).toBe('m9');
    expect(api).toHaveBeenCalledWith('/api/conversations/c1/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'On my way' }),
    });
  });

  it.each([
    [403, /opted out/i],
    [422, /No phone or email/i],
    [503, /not set up/i],
    [500, /try again/i],
  ])('maps a %i failure to friendly copy', async (status, re) => {
    const api = vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({}) });
    await expect(sendReply(asApi(api), 'c1', 'hi')).rejects.toThrow(re);
  });
});

describe('startCustomerConversation', () => {
  it('returns the (get-or-created) conversation id', async () => {
    const api = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ conversation: { id: 'conv-7' } }),
    });
    const id = await startCustomerConversation(asApi(api), 'cust-1');
    expect(id).toBe('conv-7');
    expect(api).toHaveBeenCalledWith('/api/conversations/customer/cust-1', expect.objectContaining({ method: 'POST' }));
  });

  it('throws on a non-ok response', async () => {
    const api = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    await expect(startCustomerConversation(asApi(api), 'ghost')).rejects.toThrow('HTTP 404');
  });
});
