/**
 * P5-018 — useInvoiceStatus polling hook tests.
 *
 * We use fake timers to keep the test deterministic, but `waitFor`
 * relies on real timers internally — so we explicitly flush microtasks
 * after each `advanceTimersByTime` to keep the assertions ordered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInvoiceStatus, InvoiceStatusSnapshot } from './useInvoiceStatus';

const VIEW_TOKEN = 'a'.repeat(32);
const INVOICE_ID = 'inv_test_1';

function makeFetcher(snapshots: InvoiceStatusSnapshot[]): {
  fetcher: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  let i = 0;
  const fetcher = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === 'string' ? input : input.toString());
    const snap = snapshots[Math.min(i, snapshots.length - 1)];
    i += 1;
    return {
      ok: true,
      status: 200,
      json: async () => snap,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

/**
 * Pump the microtask queue inside `act` so React processes the state
 * update from the fetch's `.then`. Two awaited resolves cover both
 * the fetcher's promise chain and the json() resolution.
 */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('P5-018 useInvoiceStatus — polling hook', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls the status endpoint immediately on mount', async () => {
    const { fetcher, calls } = makeFetcher([
      { status: 'open', amountDueCents: 12500, amountPaidCents: 0, paidAt: null },
    ]);

    const { result } = renderHook(() =>
      useInvoiceStatus(INVOICE_ID, VIEW_TOKEN, { fetcher, intervalMs: 5_000 }),
    );

    await flush();

    expect(calls.length).toBe(1);
    expect(calls[0]).toContain(`/api/public-payments/status/${INVOICE_ID}`);
    expect(calls[0]).toContain(`token=${encodeURIComponent(VIEW_TOKEN)}`);
    expect(result.current.status?.status).toBe('open');
  });

  it('polls on the configured interval and reflects status transitions', async () => {
    const { fetcher, calls } = makeFetcher([
      { status: 'open', amountDueCents: 12500, amountPaidCents: 0, paidAt: null },
      { status: 'partially_paid', amountDueCents: 5000, amountPaidCents: 7500, paidAt: null },
      { status: 'paid', amountDueCents: 0, amountPaidCents: 12500, paidAt: null },
    ]);

    const { result } = renderHook(() =>
      useInvoiceStatus(INVOICE_ID, VIEW_TOKEN, { fetcher, intervalMs: 5_000 }),
    );

    await flush();
    expect(result.current.status?.status).toBe('open');

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await flush();
    expect(result.current.status?.status).toBe('partially_paid');
    expect(result.current.status?.amountDueCents).toBe(5000);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await flush();
    expect(result.current.status?.status).toBe('paid');

    expect(calls.length).toBe(3);
  });

  it('stops polling when enabled flips to false', async () => {
    const { fetcher, calls } = makeFetcher([
      { status: 'open', amountDueCents: 12500, amountPaidCents: 0, paidAt: null },
    ]);

    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useInvoiceStatus(INVOICE_ID, VIEW_TOKEN, { fetcher, intervalMs: 5_000, enabled }),
      { initialProps: { enabled: true } },
    );

    await flush();
    expect(calls.length).toBe(1);

    rerender({ enabled: false });

    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    await flush();

    expect(calls.length).toBe(1);
  });

  it('skips fetching entirely when invoiceId is null', async () => {
    const { fetcher, calls } = makeFetcher([
      { status: 'open', amountDueCents: 12500, amountPaidCents: 0, paidAt: null },
    ]);

    renderHook(() =>
      useInvoiceStatus(null, VIEW_TOKEN, { fetcher, intervalMs: 5_000 }),
    );

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    await flush();

    expect(calls.length).toBe(0);
  });

  it('captures fetch errors without throwing', async () => {
    const fetcher = (async () => {
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
      } as Response;
    }) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useInvoiceStatus(INVOICE_ID, VIEW_TOKEN, { fetcher, intervalMs: 5_000 }),
    );

    await flush();

    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.message).toContain('500');
  });

  it('clears the interval on unmount (no late state writes)', async () => {
    const { fetcher, calls } = makeFetcher([
      { status: 'open', amountDueCents: 12500, amountPaidCents: 0, paidAt: null },
    ]);

    const { unmount } = renderHook(() =>
      useInvoiceStatus(INVOICE_ID, VIEW_TOKEN, { fetcher, intervalMs: 5_000 }),
    );

    await flush();
    expect(calls.length).toBe(1);

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    await flush();

    expect(calls.length).toBe(1);
  });
});
