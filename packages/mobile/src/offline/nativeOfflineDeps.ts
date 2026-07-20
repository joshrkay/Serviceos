import * as FileSystem from 'expo-file-system';
import type { JournalStore } from './queue';
import type { AudioRelocationDeps } from './audioRelocation';

// Native implementations of the offline-queue deps (expo-file-system). Kept
// out of queue.ts/flush.ts/audioRelocation.ts so pure logic stays RN-free and
// unit-testable; this module is excluded from coverage like the other
// native*Deps files.

const JOURNAL_PATH = () => `${FileSystem.documentDirectory}offline-queue.json`;

/**
 * Journal persistence in documentDirectory with a temp-write → move commit.
 * The temp file is fully written before it replaces the journal, so a crash
 * mid-write leaves the previous journal intact (a crash between delete and
 * move loses the journal file itself, which parseJournal degrades to an
 * empty queue — accepted over shipping a torn half-written JSON).
 */
export function makeNativeJournalStore(): JournalStore {
  return {
    async read(): Promise<string | null> {
      try {
        const info = await FileSystem.getInfoAsync(JOURNAL_PATH());
        if (!info.exists) return null;
        return await FileSystem.readAsStringAsync(JOURNAL_PATH());
      } catch {
        return null;
      }
    },
    async write(content: string): Promise<void> {
      const path = JOURNAL_PATH();
      const tmp = `${path}.tmp`;
      await FileSystem.writeAsStringAsync(tmp, content);
      await FileSystem.deleteAsync(path, { idempotent: true });
      await FileSystem.moveAsync({ from: tmp, to: path });
    },
  };
}

export const nativeAudioRelocationDeps: AudioRelocationDeps = {
  get documentDirectory() {
    return FileSystem.documentDirectory;
  },
  async makeDirectory(dir: string): Promise<void> {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  },
  async move(from: string, to: string): Promise<void> {
    await FileSystem.moveAsync({ from, to });
  },
  async delete(uri: string): Promise<void> {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  },
};
