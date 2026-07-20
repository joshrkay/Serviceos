/**
 * App-wide offline queue singleton (U12).
 *
 * Wires the RN-free {@link OfflineQueue} to the native filesystem adapter and
 * the pure {@link setWaitingCount} store (which the OfflineBanner reads). One
 * instance per app; lazily constructed so importing this module (e.g. from the
 * banner's count path) never touches the filesystem. Call {@link loadQueue}
 * once after sign-in to hydrate + recover interrupted work.
 */
import { createOfflineQueue, OfflineQueue } from './queue';
import { audioDir, journalUri, makeId, nativeQueueFs } from './nativeOfflineDeps';
import { setWaitingCount } from './waitingCount';

let instance: OfflineQueue | null = null;
let loaded = false;

export function getOfflineQueue(): OfflineQueue {
  if (!instance) {
    instance = createOfflineQueue({
      fs: nativeQueueFs,
      now: () => Date.now(),
      makeId,
      journalUri: journalUri(),
      audioDir: audioDir(),
      onCountChange: setWaitingCount,
    });
  }
  return instance;
}

/** Hydrate the journal once (idempotent). Safe to call on every mount. */
export async function loadQueue(): Promise<void> {
  if (loaded) return;
  loaded = true;
  await getOfflineQueue().load();
}
