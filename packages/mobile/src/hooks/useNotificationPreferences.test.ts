// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));

// eslint-disable-next-line import/first
import { useNotificationPreferences } from './useNotificationPreferences';

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function err(status: number, body: unknown) {
  return { ok: false, status, json: async () => body };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('useNotificationPreferences', () => {
  it('starts all-on and overlays the server map', async () => {
    h.api.mockResolvedValue(ok({ preferences: { payment_received: false } }));
    const { result } = renderHook(() => useNotificationPreferences());

    // Default-on before the fetch resolves.
    expect(result.current.preferences.payment_received).toBe(true);

    await waitFor(() => expect(result.current.preferences.payment_received).toBe(false));
    expect(result.current.preferences.emergency).toBe(true);
  });

  it('optimistically toggles and PUTs the change', async () => {
    h.api.mockResolvedValue(ok({ preferences: {} }));
    const { result } = renderHook(() => useNotificationPreferences());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    h.api.mockResolvedValueOnce(ok({ preferences: { payment_received: false } }));
    await act(async () => {
      await result.current.setPreference('payment_received', false);
    });

    expect(result.current.preferences.payment_received).toBe(false);
    const putCall = h.api.mock.calls.find((c) => c[1]?.method === 'PUT');
    expect(putCall).toBeTruthy();
    expect(JSON.parse(putCall![1].body)).toEqual({
      notificationType: 'payment_received',
      enabled: false,
    });
  });

  it('reverts the optimistic toggle and surfaces the message on failure', async () => {
    h.api.mockResolvedValue(ok({ preferences: {} }));
    const { result } = renderHook(() => useNotificationPreferences());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    h.api.mockResolvedValueOnce(err(500, { error: 'INTERNAL_ERROR', message: 'boom' }));
    await act(async () => {
      await result.current.setPreference('emergency', false);
    });

    // Reverted back to on.
    expect(result.current.preferences.emergency).toBe(true);
    expect(result.current.error).toBe('boom');
  });

  it('surfaces the backend message when the initial load fails', async () => {
    h.api.mockResolvedValue(err(500, { error: 'INTERNAL_ERROR', message: 'load failed' }));
    const { result } = renderHook(() => useNotificationPreferences());
    await waitFor(() => expect(result.current.error).toBe('load failed'));
    // Falls back to all-on so the UI still renders.
    expect(result.current.preferences.incoming_call).toBe(true);
  });
});
