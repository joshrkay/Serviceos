// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));

// eslint-disable-next-line import/first
import { useApproveBatch } from './useApproveBatch';

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('useApproveBatch', () => {
  it('POSTs the ids and returns the { approved, failed } result', async () => {
    h.api.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ approved: ['a', 'b'], failed: [{ id: 'c', reason: 'VALIDATION_ERROR' }] }),
    });
    const { result } = renderHook(() => useApproveBatch());
    const res = await result.current(['a', 'b', 'c']);

    expect(h.api).toHaveBeenCalledWith('/api/proposals/approve-batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposalIds: ['a', 'b', 'c'] }),
    });
    expect(res.approved).toEqual(['a', 'b']);
    expect(res.failed).toEqual([{ id: 'c', reason: 'VALIDATION_ERROR' }]);
  });

  it('throws the decoded backend message on a non-ok response', async () => {
    h.api.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'FORBIDDEN', message: 'Not allowed' }),
    });
    const { result } = renderHook(() => useApproveBatch());
    await expect(result.current(['a'])).rejects.toThrow('Not allowed');
  });
});
