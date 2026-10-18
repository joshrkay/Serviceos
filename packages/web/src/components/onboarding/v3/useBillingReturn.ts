import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useApiClient } from '../../../lib/apiClient';

const CONFIRMING = "Thanks. I'm confirming your trial.";
const CANCELLED = "No problem. Your trial hasn't started. Start it whenever you're ready.";
const CANCELLED_NOT_CLEARED = "That checkout was cancelled, but I couldn't clear it yet. Wait a minute, then try again.";
const CANCELLED_NOT_CONFIRMED =
  "That checkout was cancelled, but I couldn't confirm it. Check your connection, then try again in a minute.";

/**
 * The owner coming back from the payment page. The API sends them to
 * /onboarding?billing=ok after paying and ?billing=cancel after backing out
 * (routes/onboarding.ts); `success` is accepted too. The param is cleared, and:
 *   - paid: the status is checked again, because the trial starts when the
 *     payment page tells the API (a few seconds), not when the owner arrives;
 *   - cancelled: the pending checkout is released (POST /billing/cancel), or the
 *     next "Start my free trial" would be refused for up to half an hour, and
 *     the owner is told which it was.
 * Returns the one-line notice for the trial turn, or null.
 */
export function useBillingReturn(refetch: () => Promise<void>): string | null {
  const apiFetch = useApiClient();
  const [params, setParams] = useSearchParams();
  const [notice, setNotice] = useState<string | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    const billing = params.get('billing');
    if (billing === null || handled.current) return;
    handled.current = true;

    const next = new URLSearchParams(params);
    next.delete('billing');
    setParams(next, { replace: true });

    if (billing === 'ok' || billing === 'success') {
      setNotice(CONFIRMING);
      void refetch();
    } else if (billing === 'cancel') {
      void (async () => {
        try {
          const res = await apiFetch('/api/onboarding/billing/cancel', { method: 'POST' });
          setNotice(res.ok ? CANCELLED : CANCELLED_NOT_CLEARED);
        } catch {
          setNotice(CANCELLED_NOT_CONFIRMED);
        }
      })();
    }
  }, [params, setParams, apiFetch, refetch]);

  return notice;
}
