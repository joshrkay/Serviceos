/**
 * Re-run a failed read when connectivity returns.
 *
 * A read hook that errored while offline would otherwise stay broken until the
 * owner manually pulls to refresh. This hook subscribes the hook's `refetch`
 * (or `reload`/`refresh`) to the connectivity layer's offline→online edge, so a
 * reconnect heals the screen on its own.
 *
 * Gated on `enabled` (default the screen's own error state) so we only retry
 * screens that are actually broken — a healthy screen doesn't refetch on every
 * reconnect blip. The latest `retry` is held in a ref so re-subscribing on each
 * render isn't necessary and an in-flight closure can't go stale.
 */
import { useEffect, useRef } from 'react';
import { onReconnect } from './connectivity';

/**
 * @param retry  The hook's refetch/reload/refresh. May be async; the result is
 *               ignored (errors surface through the hook's own state).
 * @param enabled Only re-run on reconnect while true — typically `Boolean(error)`.
 */
export function useReconnectRetry(retry: () => unknown, enabled = true): void {
  const retryRef = useRef(retry);
  retryRef.current = retry;

  useEffect(() => {
    if (!enabled) return;
    return onReconnect(() => {
      void retryRef.current();
    });
  }, [enabled]);
}
