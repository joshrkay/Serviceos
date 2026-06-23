// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));

// eslint-disable-next-line import/first
import { useNotificationPreferences } from './useNotificationPreferences';

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

describe('useNotificationPreferences', () => {
  it('loads preferences on mount', async () => {
    h.api.mockResolvedValue(jsonResponse({ preferences: { job_assigned: true } }));
    const { result } = renderHook(() => useNotificationPreferences());
    await waitFor(() => expect(result.current.preferences.job_assigned).toBe(true));
    expect(h.api).toHaveBeenCalledWith('/api/notification-preferences');
  });

  it('optimistically toggles a preference and persists via PUT', async () => {
    h.api
      .mockResolvedValueOnce(jsonResponse({ preferences: { job_assigned: true } }))
      .mockResolvedValueOnce(jsonResponse({ preferences: { job_assigned: false } }));

    const { result } = renderHook(() => useNotificationPreferences());
    await waitFor(() => expect(result.current.preferences.job_assigned).toBe(true));

    await act(async () => {
      await result.current.setEnabled('job_assigned', false);
    });

    expect(result.current.preferences.job_assigned).toBe(false);
    expect(h.api).toHaveBeenCalledWith('/api/notification-preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationType: 'job_assigned', enabled: false }),
    });
  });

  it('reverts an optimistic toggle when PUT fails', async () => {
    h.api
      .mockResolvedValueOnce(jsonResponse({ preferences: { job_assigned: true } }))
      .mockResolvedValueOnce(jsonResponse({ error: 'FORBIDDEN', message: 'Not allowed' }, 403));

    const { result } = renderHook(() => useNotificationPreferences());
    await waitFor(() => expect(result.current.preferences.job_assigned).toBe(true));

    await act(async () => {
      await result.current.setEnabled('job_assigned', false);
    });

    expect(result.current.preferences.job_assigned).toBe(true);
    expect(result.current.error).toBe('Not allowed');
  });

  it('treats an AbortError as a non-error on reload', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    h.api.mockRejectedValue(abort);
    const { result } = renderHook(() => useNotificationPreferences());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
  });
});
