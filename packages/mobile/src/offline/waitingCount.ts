/**
 * Pure observable for the offline queue's "N actions waiting" count (U12).
 *
 * Kept deliberately free of any native import so the OfflineBanner — and its
 * jsdom test — can subscribe without pulling in expo-file-system. The offline
 * queue singleton pushes updates here via {@link setWaitingCount}; consumers
 * read/subscribe. Starts at 0 until the queue loads.
 */
type CountListener = (count: number) => void;

let waiting = 0;
const listeners = new Set<CountListener>();

export function getWaitingCount(): number {
  return waiting;
}

export function setWaitingCount(count: number): void {
  if (count === waiting) return;
  waiting = count;
  for (const l of listeners) l(waiting);
}

/** Subscribe; fires immediately with the current count, then on each change. */
export function subscribeWaitingCount(listener: CountListener): () => void {
  listeners.add(listener);
  listener(waiting);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset. */
export function __resetWaitingCountForTests(): void {
  waiting = 0;
  listeners.clear();
}
