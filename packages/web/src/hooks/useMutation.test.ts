import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useMutation } from './useMutation';

describe('useMutation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('starts with isLoading false and no error', () => {
    const { result } = renderHook(() => useMutation('POST', '/api/items'));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('calls fetch with correct method, path, and body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: '1' }),
    } as Response);

    const { result } = renderHook(() => useMutation('POST', '/api/items'));
    await act(async () => {
      await result.current.mutate({ name: 'Test' });
    });

    expect(fetchSpy).toHaveBeenCalledWith('/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test' }),
    });
  });

  it('returns parsed response on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: '42', name: 'Created' }),
    } as Response);

    const { result } = renderHook(() => useMutation<{ name: string }, { id: string; name: string }>('POST', '/api/items'));
    let response: { id: string; name: string } | undefined;
    await act(async () => {
      response = await result.current.mutate({ name: 'Created' });
    });

    expect(response).toEqual({ id: '42', name: 'Created' });
    expect(result.current.error).toBeNull();
  });

  it('sets error and re-throws on HTTP error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 422,
    } as Response);

    const { result } = renderHook(() => useMutation('POST', '/api/items'));
    await act(async () => {
      await expect(result.current.mutate({})).rejects.toThrow('HTTP 422');
    });

    expect(result.current.error).toBe('HTTP 422');
  });

  it('sets error and re-throws on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useMutation('POST', '/api/items'));
    await act(async () => {
      await expect(result.current.mutate({})).rejects.toThrow('Network error');
    });

    expect(result.current.error).toBe('Network error');
  });

  it('resets isLoading to false after request completes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    const { result } = renderHook(() => useMutation('POST', '/api/items'));
    await act(async () => {
      await result.current.mutate({});
    });

    expect(result.current.isLoading).toBe(false);
  });

  it('works with PUT method', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: '1' }),
    } as Response);

    const { result } = renderHook(() => useMutation('PUT', '/api/items/1'));
    await act(async () => {
      await result.current.mutate({ name: 'Updated' });
    });

    expect(fetchSpy).toHaveBeenCalledWith('/api/items/1', expect.objectContaining({ method: 'PUT' }));
  });
});
