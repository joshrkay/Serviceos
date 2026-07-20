import { OfflineQueue } from './queue';
import { makeNativeJournalStore } from './nativeOfflineDeps';

/**
 * Process-wide offline queue singleton (same module-singleton pattern as
 * `lib/connectivity.ts`). Capture hooks enqueue into it from anywhere; the
 * flush hook mounted in the root layout drains it.
 */
let instance: OfflineQueue | null = null;

export function getOfflineQueue(): OfflineQueue {
  if (!instance) instance = new OfflineQueue(makeNativeJournalStore());
  return instance;
}

/** Test-only: swap in a queue backed by an in-memory store (null resets). */
export function __setOfflineQueueForTests(queue: OfflineQueue | null): void {
  instance = queue;
}
