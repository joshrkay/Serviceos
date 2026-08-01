import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system';
import type { QueueFs } from './queue';

// Native implementations of the injectable offline-queue deps. Kept out of
// queue.ts so the journal logic stays RN-free and unit-testable (mirrors
// nativeVoiceDeps.ts). This module never runs under vitest — the queue tests
// inject an in-memory QueueFs.

/**
 * Durable journal + audio locations live under documentDirectory (not the
 * evictable cache dir). Computed lazily — never at import — so a test that
 * strict-mocks expo-file-system without a `documentDirectory` export can still
 * import the modules that reference this adapter without tripping the mock.
 */
export function journalUri(): string {
  return `${FileSystem.documentDirectory ?? ''}offline-queue.json`;
}
export function audioDir(): string {
  return `${FileSystem.documentDirectory ?? ''}offline-audio/`;
}

export function makeId(): string {
  return Crypto.randomUUID();
}

export const nativeQueueFs: QueueFs = {
  async read(uri) {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return null;
    return FileSystem.readAsStringAsync(uri);
  },
  async write(uri, data) {
    await FileSystem.writeAsStringAsync(uri, data);
  },
  async move(from, to) {
    // expo-file-system's moveAsync overwrites the destination and removes the
    // source — exactly the atomic-swap / cache-eviction semantics we want.
    await FileSystem.moveAsync({ from, to });
  },
  async remove(uri) {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  },
  async ensureDir(uri) {
    await FileSystem.makeDirectoryAsync(uri, { intermediates: true }).catch(() => {
      // Already exists — makeDirectoryAsync rejects on a pre-existing dir.
    });
  },
};
