/**
 * Queued-audio relocation (U12). A freshly recorded clip lives in the OS
 * cache directory, which the OS may evict at any time — an enqueued offline
 * recording must survive until it flushes, so enqueue moves the file into a
 * dedicated folder under `documentDirectory` and the journal stores the new
 * URI. Deletion happens only after a confirmed flush (see flush.ts).
 *
 * Pure orchestration over injected FS ops so it unit-tests under vitest (the
 * repo's jest-expo lane is intentionally unwired — see pr-checks.yml); the
 * native binding lives in `nativeOfflineDeps.ts`.
 */

export interface AudioRelocationDeps {
  /** `FileSystem.documentDirectory` — null on platforms without one (web export). */
  documentDirectory: string | null;
  /** mkdir -p semantics; must tolerate the directory already existing. */
  makeDirectory(dir: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  /** Must tolerate a missing file (idempotent delete). */
  delete(uri: string): Promise<void>;
}

export const OFFLINE_AUDIO_DIR = 'offline-voice';

function extensionOf(uri: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(uri);
  return match ? match[1].toLowerCase() : 'm4a';
}

/** Destination URI for a queued item's audio, keyed by the item id. */
export function queuedAudioPath(documentDirectory: string, itemId: string, sourceUri: string): string {
  const base = documentDirectory.endsWith('/') ? documentDirectory : `${documentDirectory}/`;
  return `${base}${OFFLINE_AUDIO_DIR}/${itemId}.${extensionOf(sourceUri)}`;
}

/**
 * Move a recorded clip out of the evictable cache into the offline-audio
 * folder. Returns the relocated URI to store in the journal payload.
 */
export async function relocateAudioForQueue(
  deps: AudioRelocationDeps,
  input: { itemId: string; sourceUri: string },
): Promise<string> {
  if (!deps.documentDirectory) {
    throw new Error('Offline capture is not supported on this platform.');
  }
  const base = deps.documentDirectory.endsWith('/')
    ? deps.documentDirectory
    : `${deps.documentDirectory}/`;
  await deps.makeDirectory(`${base}${OFFLINE_AUDIO_DIR}`);
  const target = queuedAudioPath(deps.documentDirectory, input.itemId, input.sourceUri);
  await deps.move(input.sourceUri, target);
  return target;
}

/** Idempotent cleanup after a confirmed flush (or a cancelled item). */
export async function deleteQueuedAudio(deps: AudioRelocationDeps, uri: string): Promise<void> {
  await deps.delete(uri);
}
