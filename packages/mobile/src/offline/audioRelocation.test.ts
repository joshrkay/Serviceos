import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// U12 — the cache→documentDirectory relocation + "delete only after a confirmed
// flush" contract, exercised through the REAL native adapter (nativeQueueFs)
// with expo-file-system mocked. Pure vitest (mocked fs), so it needs no device
// and no jest-expo lane.
const h = vi.hoisted(() => ({
  moveAsync: vi.fn(async () => {}),
  deleteAsync: vi.fn(async () => {}),
  writeAsStringAsync: vi.fn(async () => {}),
  readAsStringAsync: vi.fn(async () => ''),
  getInfoAsync: vi.fn(async () => ({ exists: false as boolean })),
  makeDirectoryAsync: vi.fn(async () => {}),
}));

vi.mock('expo-file-system', () => ({
  documentDirectory: 'file:///doc/',
  moveAsync: h.moveAsync,
  deleteAsync: h.deleteAsync,
  writeAsStringAsync: h.writeAsStringAsync,
  readAsStringAsync: h.readAsStringAsync,
  getInfoAsync: h.getInfoAsync,
  makeDirectoryAsync: h.makeDirectoryAsync,
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));

// eslint-disable-next-line import/first
import { audioDir, journalUri, nativeQueueFs } from './nativeOfflineDeps';
// eslint-disable-next-line import/first
import { createOfflineQueue, isVoiceItem } from './queue';

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

async function loadedQueue() {
  let n = 0;
  const q = createOfflineQueue({
    fs: nativeQueueFs,
    now: () => 0,
    makeId: () => `id-${++n}`,
    journalUri: journalUri(),
    audioDir: audioDir(),
  });
  await q.load();
  return q;
}

describe('audio relocation (native adapter)', () => {
  it('moves the recorded clip out of cache into documentDirectory at enqueue', async () => {
    const q = await loadedQueue();
    const item = await q.enqueueVoice({
      sourceUri: 'file:///cache/Audio/rec.m4a',
      contentType: 'audio/mp4',
      sizeBytes: 99,
    });
    if (!isVoiceItem(item)) throw new Error('unreachable');

    // The durable uri lives under documentDirectory, not the cache dir.
    expect(item.payload.audioUri.startsWith('file:///doc/offline-audio/')).toBe(true);
    // moveAsync relocated the cache clip to that durable uri.
    expect(h.moveAsync).toHaveBeenCalledWith({
      from: 'file:///cache/Audio/rec.m4a',
      to: item.payload.audioUri,
    });
    // The durable audio has NOT been deleted — it must survive until flush.
    expect(h.deleteAsync).not.toHaveBeenCalledWith(item.payload.audioUri, expect.anything());
  });

  it('deletes the durable audio only after a confirmed flush (markDone)', async () => {
    const q = await loadedQueue();
    const item = await q.enqueueVoice({
      sourceUri: 'file:///cache/Audio/rec.m4a',
      contentType: 'audio/mp4',
      sizeBytes: 99,
    });
    if (!isVoiceItem(item)) throw new Error('unreachable');
    const durable = item.payload.audioUri;

    // A mid-flight checkpoint does NOT delete the audio.
    await q.markInflight(item.id);
    await q.setCheckpoint(item.id, { fileId: 'f1', audioUrl: 'https://cdn/f1' });
    expect(h.deleteAsync).not.toHaveBeenCalledWith(durable, { idempotent: true });

    // Confirmed flush deletes it (idempotently).
    await q.markDone(item.id);
    expect(h.deleteAsync).toHaveBeenCalledWith(durable, { idempotent: true });
  });
});
