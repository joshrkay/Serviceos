/**
 * Pure "the user asked to retry the offline queue now" signal (U12 follow-up).
 *
 * Decouples a manual-retry affordance (the approvals pull-to-refresh, which
 * lives deep in the screen tree) from the flush controller (owned by
 * `useOfflineSync`, mounted once at the app root). Mirrors `waitingCount.ts`:
 * a native-free observable so the emitter and the jsdom tests never pull in
 * expo-file-system. `useOfflineSync` subscribes and runs the controller's
 * `retry()` (reactivate poison-parked items + drain) on each request.
 */
type FlushRequestListener = () => Promise<void> | void;

const listeners = new Set<FlushRequestListener>();

/**
 * Ask the mounted flush controller to reactivate parked items and drain now.
 * Resolves once every subscriber has settled, so a caller (the approvals
 * pull-to-refresh) can await the drain before re-fetching the inbox — otherwise
 * a concurrent inbox GET can race ahead of the queued approve POSTs and briefly
 * show a just-approved item as still pending. `allSettled` so one listener's
 * failure (a flush that threw) never rejects the request for the others.
 */
export async function requestOfflineFlush(): Promise<void> {
  const pending: Array<Promise<void>> = [];
  for (const l of listeners) {
    try {
      const res = l();
      if (res) pending.push(res);
    } catch {
      // A listener that throws synchronously must not block the others.
    }
  }
  await Promise.allSettled(pending);
}

/** Subscribe to manual flush requests; returns an unsubscribe. */
export function subscribeOfflineFlushRequests(listener: FlushRequestListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset. */
export function __resetOfflineFlushSignalForTests(): void {
  listeners.clear();
}
