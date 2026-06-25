// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DigestPayload, DigestResponse } from '../api/digest';

const h = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));

// eslint-disable-next-line import/first
import { useDigest } from './useDigest';

const basePayload: DigestPayload = {
  date: '2026-06-10',
  timezone: 'America/New_York',
  revenueCents: 125_00,
  grossRevenueCents: 130_00,
  refundsCents: 5_00,
  paymentsCount: 3,
  jobsCompletedCount: 2,
  tomorrow: { appointmentCount: 1, firstStartIso: '2026-06-12T13:00:00.000Z' },
  pendingApprovals: { totalCount: 2, top: [] },
  overdueInvoicesCount: 4,
  unbilledJobs: [],
};

function okDigest(date = '2026-06-10'): DigestResponse {
  return {
    date,
    payload: basePayload,
    narrative: 'A solid day.',
    generatedAt: '2026-06-10T22:00:00.000Z',
  };
}

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

describe('useDigest', () => {
  it('loads the latest digest', async () => {
    h.api.mockResolvedValue(jsonResponse({ data: okDigest() }));
    const { result } = renderHook(() => useDigest('latest'));
    await waitFor(() => expect(result.current.data?.narrative).toBe('A solid day.'));
    expect(h.api).toHaveBeenCalledWith('/api/digests/latest');
  });

  it('loads a digest for an explicit date', async () => {
    h.api.mockResolvedValue(jsonResponse({ data: okDigest('2026-06-10') }));
    const { result } = renderHook(() => useDigest('2026-06-10'));
    await waitFor(() => expect(result.current.data?.date).toBe('2026-06-10'));
    expect(h.api).toHaveBeenCalledWith('/api/digests/2026-06-10');
  });

  it('drops a superseded (out-of-order) response', async () => {
    const resolvers: Array<(r: unknown) => void> = [];
    h.api.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const { result } = renderHook(() => useDigest('latest'));

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      void result.current.refetch();
      await Promise.resolve();
    });
    expect(resolvers).toHaveLength(2);

    await act(async () => {
      resolvers[1]!(jsonResponse({ data: okDigest('2026-06-11') }));
      await Promise.resolve();
    });
    await act(async () => {
      resolvers[0]!(jsonResponse({ data: okDigest('2026-06-09') }));
      await Promise.resolve();
    });

    expect(result.current.data?.date).toBe('2026-06-11');
  });

  it('treats an AbortError as a non-error', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    h.api.mockRejectedValue(abort);
    const { result } = renderHook(() => useDigest('latest'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
  });

  it('surfaces the backend error message on failure', async () => {
    h.api.mockResolvedValue(
      jsonResponse({ error: 'NOT_FOUND', message: 'No digest for this day' }, 404),
    );
    const { result } = renderHook(() => useDigest('2026-06-10'));
    await waitFor(() => expect(result.current.error).toBe('No digest for this day'));
  });
});
