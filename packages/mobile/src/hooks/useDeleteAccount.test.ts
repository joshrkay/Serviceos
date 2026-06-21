// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));

// eslint-disable-next-line import/first
import { useDeleteAccount } from './useDeleteAccount';

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('useDeleteAccount', () => {
  it('POSTs confirm:true to /api/account/delete and resolves true on 202', async () => {
    h.api.mockResolvedValue({ ok: true, status: 202, json: async () => ({ enqueued: true }) });
    const { result } = renderHook(() => useDeleteAccount());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deleteAccount();
    });

    expect(ok).toBe(true);
    expect(h.api).toHaveBeenCalledWith('/api/account/delete', {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    });
    expect(result.current.error).toBeNull();
  });

  it('resolves false and surfaces the server message on a 403 (non-owner)', async () => {
    h.api.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'FORBIDDEN', message: 'Only the owner can delete the account.' }),
    });
    const { result } = renderHook(() => useDeleteAccount());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deleteAccount();
    });

    expect(ok).toBe(false);
    expect(result.current.phase).toBe('error');
    expect(result.current.error).toBe('Only the owner can delete the account.');
  });

  it('resolves false on a transport failure', async () => {
    h.api.mockRejectedValue(new Error('Network request failed'));
    const { result } = renderHook(() => useDeleteAccount());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deleteAccount();
    });

    expect(ok).toBe(false);
    expect(result.current.phase).toBe('error');
    expect(result.current.error).toBeTruthy();
  });
});
