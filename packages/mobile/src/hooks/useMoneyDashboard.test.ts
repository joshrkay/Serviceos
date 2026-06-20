// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));

// eslint-disable-next-line import/first
import { useMoneyDashboard } from './useMoneyDashboard';

const summary = {
  month: '2026-06',
  revenueCents: 1_250_000,
  outstandingCents: 340_000,
  overdueCents: 50_000,
  revenueTrendCents: 120_000,
};

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('useMoneyDashboard', () => {
  it('loads the current-month summary from the { data } envelope', async () => {
    h.api.mockResolvedValue(ok({ data: summary }));
    const { result } = renderHook(() => useMoneyDashboard());
    await waitFor(() => expect(result.current.summary).toEqual(summary));
    expect(result.current.error).toBeNull();
    expect(result.current.notConfigured).toBe(false);
    // Always queries the current month in YYYY-MM form.
    expect(h.api).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/reports\/money-dashboard\?month=\d{4}-\d{2}$/));
  });

  it('degrades to notConfigured on a 503 instead of erroring', async () => {
    h.api.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: 'NOT_CONFIGURED' }) });
    const { result } = renderHook(() => useMoneyDashboard());
    await waitFor(() => expect(result.current.notConfigured).toBe(true));
    expect(result.current.summary).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('surfaces a non-ok (non-503) response as an error', async () => {
    h.api.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const { result } = renderHook(() => useMoneyDashboard());
    await waitFor(() => expect(result.current.error).toBe('HTTP 500'));
    expect(result.current.summary).toBeNull();
  });

  it('treats an AbortError as a non-error (sign-out mid-flight)', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    h.api.mockRejectedValue(abort);
    const { result } = renderHook(() => useMoneyDashboard());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
  });
});
