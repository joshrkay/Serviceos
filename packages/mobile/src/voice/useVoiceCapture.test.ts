// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Rendered via @testing-library/react (a repo-root devDep) under jsdom so this
// runs in the root-hoisted CI lane without installing the mobile Expo deps.
// React is pinned to the root copy in vitest.config.ts so the hook (which would
// otherwise resolve React from packages/mobile/node_modules) shares one
// instance with the renderer. The native modules below are mocked, so the real
// expo-* packages need not be installed.

// Controllable mocks for the native deps. vi.hoisted runs before the vi.mock
// factories so they can close over these without a TDZ error.
const h = vi.hoisted(() => ({
  permission: vi.fn(),
  setAudioMode: vi.fn(),
  prepare: vi.fn(),
  record: vi.fn(),
  stop: vi.fn(),
  getInfo: vi.fn(),
  upload: vi.fn(),
  apiFn: vi.fn(),
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
vi.mock('./nativeVoiceDeps', () => ({ makeIdempotencyKey: () => 'idem-key', uploadFile: vi.fn() }));
vi.mock('./uploadAndTranscribe', () => ({ uploadAndTranscribe: h.upload }));

// eslint-disable-next-line import/first
import { useVoiceCapture } from './useVoiceCapture';

/** Flush pending microtasks (one macrotask drains the awaited promise chain). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  h.permission.mockResolvedValue({ granted: true });
  h.setAudioMode.mockResolvedValue(undefined);
  h.prepare.mockResolvedValue(undefined);
  h.stop.mockResolvedValue(undefined);
  h.getInfo.mockResolvedValue({ exists: true, size: 2048 });
  // U3 — uploadAndTranscribe now returns { transcript, outcome }.
  h.upload.mockResolvedValue({
    transcript: 'reschedule the Tuesday job',
    outcome: { kind: 'proposal' },
  });
  h.recorder.prepareToRecordAsync = h.prepare;
  h.recorder.record = h.record;
  h.recorder.stop = h.stop;
  h.recorder.uri = 'file:///clip.m4a';
});

afterEach(() => {
  cleanup();
});

describe('useVoiceCapture', () => {
  it('happy path — press-in records, release uploads and shows the transcript', async () => {
    const { result } = renderHook(() => useVoiceCapture());

    await act(async () => {
      await result.current.startRecording();
    });
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('listening');

    await act(async () => {
      await result.current.stopAndTranscribe();
    });
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('transcript');
    expect(result.current.transcript).toBe('reschedule the Tuesday job');
    // U3 — the routed outcome is surfaced to the screen.
    expect(result.current.outcome).toEqual({ kind: 'proposal' });
  });

  it('passes a job-scoped capture through to the upload pipeline', async () => {
    const jobId = '3b6cbf1a-bd8a-45f7-8b84-ce6b43a231d1';
    const { result } = renderHook(() => useVoiceCapture(jobId));

    await act(async () => {
      await result.current.startRecording();
      await result.current.stopAndTranscribe();
    });

    expect(h.upload).toHaveBeenCalledWith(
      {
        fileUri: 'file:///clip.m4a',
        contentType: 'audio/mp4',
        sizeBytes: 2048,
      },
      expect.objectContaining({ api: h.apiFn }),
      jobId,
    );
  });

  it('permission denied — surfaces an error and never records, then recovers on the next press', async () => {
    h.permission.mockResolvedValueOnce({ granted: false });
    const { result } = renderHook(() => useVoiceCapture());

    await act(async () => {
      await result.current.startRecording();
    });
    expect(h.record).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('error');

    // A stale stopRequestedRef must not block the next start.
    await act(async () => {
      await result.current.startRecording();
    });
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('listening');
  });

  it('release while starting — cancels before record(), never opens the mic', async () => {
    let resolvePrepare!: () => void;
    h.prepare.mockReturnValueOnce(new Promise<void>((r) => (resolvePrepare = r)));
    const { result } = renderHook(() => useVoiceCapture());

    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = result.current.startRecording();
      await flush(); // advance to the suspended prepareToRecordAsync()
    });

    // onPressOut fires while still 'starting'.
    await act(async () => {
      await result.current.stopAndTranscribe();
    });

    await act(async () => {
      resolvePrepare();
      await startPromise;
    });

    expect(h.record).not.toHaveBeenCalled();
    // The prepared recorder is reset (stop) so a later press can prepare again,
    // but nothing is transcribed.
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.upload).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('idle');

    // A second press must succeed (no "stuck on prepared recorder").
    h.prepare.mockResolvedValueOnce(undefined);
    await act(async () => {
      await result.current.startRecording();
    });
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('listening');
  });

  it('reset while recording — stops and discards the mic without transcribing', async () => {
    const { result } = renderHook(() => useVoiceCapture());
    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.phase).toBe('listening');

    await act(async () => {
      result.current.reset();
    });
    expect(h.stop).toHaveBeenCalledTimes(1); // discard stop
    expect(h.upload).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('idle');

    // State is back to idle: a trailing release is a no-op (no double stop).
    await act(async () => {
      await result.current.stopAndTranscribe();
    });
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it('reset while starting — aborts the in-flight start, never opening the mic', async () => {
    let resolvePrepare!: () => void;
    h.prepare.mockReturnValueOnce(new Promise<void>((r) => (resolvePrepare = r)));
    const { result } = renderHook(() => useVoiceCapture());

    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = result.current.startRecording();
      await flush();
    });

    await act(async () => {
      result.current.reset();
    });

    await act(async () => {
      resolvePrepare();
      await startPromise;
    });

    expect(h.record).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('idle');
  });
});
