import { describe, expect, it, vi, beforeEach } from 'vitest';
import { searchConversations } from './conversations';

vi.mock('../utils/api-fetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../utils/api-fetch';

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe('searchConversations (Story 3.11)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('short-circuits an empty query without hitting the server', async () => {
    await expect(searchConversations('   ')).resolves.toEqual([]);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('builds a q query and returns results', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      ok({ results: [{ message: { id: 'm1' }, conversation: { id: 'c1' } }] }),
    );
    const hits = await searchConversations('rodriguez');
    expect(hits).toHaveLength(1);
    expect(hits[0].conversation.id).toBe('c1');
    const url = String(vi.mocked(apiFetch).mock.calls[0][0]);
    expect(url).toContain('/api/conversations/search?');
    expect(url).toContain('q=rodriguez');
  });

  it('passes entity convenience filters through', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok({ results: [] }));
    await searchConversations('', { customerId: 'cust-7', limit: 10 });
    const url = String(vi.mocked(apiFetch).mock.calls[0][0]);
    expect(url).toContain('customerId=cust-7');
    expect(url).toContain('limit=10');
  });

  it('throws on a non-OK response', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    await expect(searchConversations('x')).rejects.toThrow(/Search failed/);
  });
});
