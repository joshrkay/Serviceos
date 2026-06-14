/**
 * P5-018 — Invoice status polling hook.
 *
 * Polls the public view-token-gated status endpoint while a customer
 * payment is settling asynchronously (ACH / processing intents whose
 * webhook reconciliation hasn't completed yet). When the status flips
 * to `paid` the consumer should pass `enabled: false` to stop polling.
 *
 * Why polling over websockets / SSE: Railway support + cost overhead.
 * 5s polling is the simplest mechanism that keeps the customer page
 * responsive without adding new infrastructure.
 */
import { useEffect, useRef, useState } from 'react';

export type InvoiceStatusValue =
  | 'draft'
  | 'open'
  | 'partially_paid'
  | 'paid'
  | 'void'
  | 'canceled';

export interface InvoiceStatusSnapshot {
  status: InvoiceStatusValue;
  amountDueCents: number;
  amountPaidCents: number;
  paidAt: string | null;
  /**
   * E2a (one-time ACH) — true while an in-flight `processing` payment
   * exists for the invoice (a bank transfer settling over 1–4 business
   * days). The invoice itself stays `open`; this is a payment-level
   * signal so the page can show a persistent "payment processing" state
   * that survives reloads and flips to the paid screen on settlement.
   * Optional for backwards compatibility with older API responses.
   */
  paymentProcessing?: boolean;
}

export interface UseInvoiceStatusOptions {
  /** Polling interval in ms. Defaults to 5000 (5 seconds). */
  intervalMs?: number;
  /** When false, the hook does not poll. Defaults to true. */
  enabled?: boolean;
  /**
   * Optional fetch override. Lets tests inject a stubbed implementation
   * without monkey-patching globals.
   */
  fetcher?: typeof fetch;
}

export interface UseInvoiceStatusResult {
  status: InvoiceStatusSnapshot | null;
  error: Error | null;
}

/**
 * Polls `/api/public-payments/status/:invoiceId?token=…` every
 * `intervalMs` until disabled. The first request fires immediately so
 * consumers don't have to wait `intervalMs` for the initial snapshot.
 */
export function useInvoiceStatus(
  invoiceId: string | null,
  viewToken: string | null,
  options: UseInvoiceStatusOptions = {},
): UseInvoiceStatusResult {
  const intervalMs = options.intervalMs ?? 5_000;
  const enabled = options.enabled ?? true;
  const fetcher = options.fetcher ?? fetch;

  const [status, setStatus] = useState<InvoiceStatusSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Track the latest fetcher in a ref so changing it (e.g. via a test
  // re-render) doesn't tear down the interval — only the id/token/
  // enabled/intervalMs trio should restart polling.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled || !invoiceId || !viewToken) return;

    let cancelled = false;

    const tick = async () => {
      try {
        const res = await fetcherRef.current(
          `/api/public-payments/status/${invoiceId}?token=${encodeURIComponent(viewToken)}`,
        );
        if (!res.ok) {
          throw new Error(`Status fetch failed: ${res.status}`);
        }
        const body = (await res.json()) as InvoiceStatusSnapshot;
        if (!cancelled) {
          setStatus(body);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    };

    void tick();
    const id = setInterval(() => {
      void tick();
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [invoiceId, viewToken, intervalMs, enabled]);

  return { status, error };
}
