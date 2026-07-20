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
type FlushRequestListener = () => void;

const listeners = new Set<FlushRequestListener>();

/** Ask the mounted flush controller to reactivate parked items and drain now. */
export function requestOfflineFlush(): void {
  for (const l of listeners) l();
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
