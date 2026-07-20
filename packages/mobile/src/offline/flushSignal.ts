/**
 * Manual-retry signal for the offline queue (U12). A tiny standalone module —
 * no native imports — so UI surfaces (e.g. the approvals pull-to-refresh) can
 * request a flush without dragging the flush hook's native dependency tree
 * into their import graph. The mounted `useOfflineFlush` hook subscribes.
 */
const listeners = new Set<() => void>();

export function onOfflineFlushRequested(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function requestOfflineFlush(): void {
  for (const l of listeners) l();
}
