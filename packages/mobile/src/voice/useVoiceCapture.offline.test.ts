// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// U12 — offline capture: instead of uploading, the clip relocates out of the
// cache and journals with a replay key minted once at enqueue.
const h = vi.hoisted(() => ({
  permission: vi.fn(),
  setAudioMode: vi.fn(),
  getInfo: vi.fn(),
  upload: vi.fn(),
  apiFn: vi.fn(),
  online: true,
  enqueueVoice: vi.fn(),
  relocate: vi.fn(),
  keyCounter: 0,
  recorder: { prepareToRecordAsync: vi.fn(), record: vi.fn(), stop: vi.fn(), uri: '' as string | null },
}));

vi.mock('expo-audio', () => ({
  AudioModule: { requestRecordingPermissionsAsync: h.permission },
  setAudioModeAsync: h.setAudioMode,
  RecordingPresets: { HIGH_QUALITY: {} },
  useAudioRecorder: () => h.recorder,
}));
vi.mock('expo-file-system', () => ({ getInfoAsync: h.getInfo }));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.apiFn }));
vi.mock('../lib/connectivity', () => ({ isCurrentlyOnline: () => h.online }));
vi.mock('./nativeVoiceDeps', () => ({
  makeIdempotencyKey: () => `key-${++h.keyCounter}`,
  uploadFile: vi.fn(),
}));
vi.mock('./uploadAndTranscribe', () => ({ uploadAndTranscribe: h.upload }));
vi.mock('../offline/queueInstance', () => ({
  getOfflineQueue: () => ({ enqueueVoice: h.enqueueVoice }),
}));
vi.mock('../offline/nativeOfflineDeps', () => ({ nativeAudioRelocationDeps: {} }));
vi.mock('../offline/audioRelocation', () => ({ relocateAudioForQueue: h.relocate }));

// eslint-disable-next-line import/first
import { useVoiceCapture } from './useVoiceCapture';

beforeEach(() => {
  vi.clearAllMocks();
  h.online = true;
  h.keyCounter = 0;
  h.permission.mockResolvedValue({ granted: true });
  h.setAudioMode.mockResolvedValue(undefined);
  h.getInfo.mockResolvedValue({ exists: true, size: 2048 });
  h.upload.mockResolvedValue('transcript');
  h.relocate.mockResolvedValue('file:///doc/offline-voice/key-1.m4a');
  h.enqueueVoice.mockResolvedValue({});
  h.recorder.prepareToRecordAsync = vi.fn().mockResolvedValue(undefined);
  h.recorder.record = vi.fn();
  h.recorder.stop = vi.fn().mockResolvedValue(undefined);
  h.recorder.uri = 'file:///cache/clip.m4a';
});

afterEach(() => {
  cleanup();
});

async function captureOnce(result: { current: ReturnType<typeof useVoiceCapture> }) {
  await act(async () => {
    await result.current.startRecording();
  });
  await act(async () => {
    await result.current.stopAndTranscribe();
  });
}

describe('useVoiceCapture — offline queueing (U12)', () => {
  it('queues the clip instead of uploading when offline', async () => {
    h.online = false;
    const { result } = renderHook(() => useVoiceCapture());

    await captureOnce(result);

    expect(result.current.phase).toBe('queued');
    expect(h.upload).not.toHaveBeenCalled();
    // Relocated out of the evictable cache, keyed by the item id.
    expect(h.relocate).toHaveBeenCalledWith({}, expect.objectContaining({
      itemId: 'key-1',
      sourceUri: 'file:///cache/clip.m4a',
    }));
    expect(h.enqueueVoice).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'key-1',
        idempotencyKey: 'key-2', // minted once, at enqueue
        payload: expect.objectContaining({
          localUri: 'file:///doc/offline-voice/key-1.m4a',
          contentType: 'audio/mp4',
          sizeBytes: 2048,
        }),
      }),
    );
  });

  it('carries the job context into the queued payload', async () => {
    h.online = false;
    const { result } = renderHook(() => useVoiceCapture('job-9'));

    await captureOnce(result);

    expect(h.enqueueVoice).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ jobId: 'job-9' }) }),
    );
  });

  it('falls back to the queue when the connection drops mid-upload', async () => {
    h.upload.mockRejectedValue(new Error('Network request failed'));
    const { result } = renderHook(() => useVoiceCapture());

    await captureOnce(result);

    expect(result.current.phase).toBe('queued');
    expect(h.enqueueVoice).toHaveBeenCalledTimes(1);
  });

  it('keeps the normal error path for a non-transport failure', async () => {
    h.upload.mockRejectedValue(new Error('Transcription failed.'));
    const { result } = renderHook(() => useVoiceCapture());

    await captureOnce(result);

    expect(result.current.phase).toBe('error');
    expect(h.enqueueVoice).not.toHaveBeenCalled();
  });

  it('uploads normally while online', async () => {
    const { result } = renderHook(() => useVoiceCapture());

    await captureOnce(result);

    expect(result.current.phase).toBe('transcript');
    expect(h.enqueueVoice).not.toHaveBeenCalled();
  });
});
