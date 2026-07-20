import { describe, expect, it, vi } from 'vitest';
import {
  OFFLINE_AUDIO_DIR,
  deleteQueuedAudio,
  queuedAudioPath,
  relocateAudioForQueue,
  type AudioRelocationDeps,
} from './audioRelocation';

function fakeDeps(documentDirectory: string | null = 'file:///doc/'): AudioRelocationDeps & {
  makeDirectory: ReturnType<typeof vi.fn>;
  move: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  return {
    documentDirectory,
    makeDirectory: vi.fn(async () => {}),
    move: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

describe('audio relocation', () => {
  it('moves a recorded clip from the cache into the offline-audio folder', async () => {
    const deps = fakeDeps();

    const uri = await relocateAudioForQueue(deps, {
      itemId: 'item-1',
      sourceUri: 'file:///cache/AV/recording-77.m4a',
    });

    expect(deps.makeDirectory).toHaveBeenCalledWith(`file:///doc/${OFFLINE_AUDIO_DIR}`);
    expect(deps.move).toHaveBeenCalledWith(
      'file:///cache/AV/recording-77.m4a',
      `file:///doc/${OFFLINE_AUDIO_DIR}/item-1.m4a`,
    );
    expect(uri).toBe(`file:///doc/${OFFLINE_AUDIO_DIR}/item-1.m4a`);
  });

  it('keeps the source extension and defaults to m4a when there is none', () => {
    expect(queuedAudioPath('file:///doc/', 'a', 'file:///cache/x.AAC')).toBe(
      `file:///doc/${OFFLINE_AUDIO_DIR}/a.aac`,
    );
    expect(queuedAudioPath('file:///doc', 'b', 'file:///cache/noext')).toBe(
      `file:///doc/${OFFLINE_AUDIO_DIR}/b.m4a`,
    );
  });

  it('refuses to enqueue on a platform without a document directory', async () => {
    const deps = fakeDeps(null);

    await expect(
      relocateAudioForQueue(deps, { itemId: 'x', sourceUri: 'file:///cache/a.m4a' }),
    ).rejects.toThrow(/not supported/i);
    expect(deps.move).not.toHaveBeenCalled();
  });

  it('deletes queued audio through the idempotent delete', async () => {
    const deps = fakeDeps();
    await deleteQueuedAudio(deps, 'file:///doc/offline-voice/item-1.m4a');
    expect(deps.delete).toHaveBeenCalledWith('file:///doc/offline-voice/item-1.m4a');
  });
});
