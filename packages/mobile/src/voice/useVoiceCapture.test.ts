import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseVoiceCaptureResult } from './useVoiceCapture';

// react-test-renderer renders to a plain JS tree (no DOM), so it runs under the
// suite's `node` environment. Its ambient types live in
// packages/mobile/types/react-test-renderer.d.ts.

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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Render the hook in a throwaway component and expose its latest result. */
function renderVoiceCapture(): { current: UseVoiceCaptureResult } {
  const ref = { current: null as unknown as UseVoiceCaptureResult };
  function Probe(): null {
    ref.current = useVoiceCapture();
    return null;
  }
  act(() => {
    TestRenderer.create(React.createElement(Probe));
  });
  return ref;
}

/** Flush pending microtasks (one macrotask drains the awaited promise chain). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  h.permission.mockResolvedValue({ granted: true });
  h.setAudioMode.mockResolvedValue(undefined);
  h.prepare.mockResolvedValue(undefined);
  h.stop.mockResolvedValue(undefined);
  h.getInfo.mockResolvedValue({ exists: true, size: 2048 });
  h.upload.mockResolvedValue('reschedule the Tuesday job');
  h.recorder.prepareToRecordAsync = h.prepare;
  h.recorder.record = h.record;
  h.recorder.stop = h.stop;
  h.recorder.uri = 'file:///clip.m4a';
});

describe('useVoiceCapture', () => {
  it('happy path — press-in records, release uploads and shows the transcript', async () => {
    const ref = renderVoiceCapture();

    await act(async () => {
      await ref.current.startRecording();
    });
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(ref.current.phase).toBe('listening');

    await act(async () => {
      await ref.current.stopAndTranscribe();
    });
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(ref.current.phase).toBe('transcript');
    expect(ref.current.transcript).toBe('reschedule the Tuesday job');
  });

  it('permission denied — surfaces an error and never records, then recovers on the next press', async () => {
    h.permission.mockResolvedValueOnce({ granted: false });
    const ref = renderVoiceCapture();

    await act(async () => {
      await ref.current.startRecording();
    });
    expect(h.record).not.toHaveBeenCalled();
    expect(ref.current.phase).toBe('error');

    // Stale stopRequestedRef must not block the next start.
    await act(async () => {
      await ref.current.startRecording();
    });
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(ref.current.phase).toBe('listening');
  });

  it('release while starting — cancels before record(), never opens the mic', async () => {
    let resolvePrepare!: () => void;
    h.prepare.mockReturnValueOnce(new Promise<void>((r) => (resolvePrepare = r)));
    const ref = renderVoiceCapture();

    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = ref.current.startRecording();
      await flush(); // advance to the suspended prepareToRecordAsync()
    });

    // onPressOut fires while still 'starting'.
    await act(async () => {
      await ref.current.stopAndTranscribe();
    });

    await act(async () => {
      resolvePrepare();
      await startPromise;
    });

    expect(h.record).not.toHaveBeenCalled();
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    expect(ref.current.phase).toBe('idle');
  });

  it('reset while recording — stops and discards the mic without transcribing', async () => {
    const ref = renderVoiceCapture();
    await act(async () => {
      await ref.current.startRecording();
    });
    expect(ref.current.phase).toBe('listening');

    await act(async () => {
      ref.current.reset();
    });
    expect(h.stop).toHaveBeenCalledTimes(1); // discard stop
    expect(h.upload).not.toHaveBeenCalled();
    expect(ref.current.phase).toBe('idle');

    // State is back to idle: a trailing release is a no-op (no double stop).
    await act(async () => {
      await ref.current.stopAndTranscribe();
    });
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it('reset while starting — aborts the in-flight start, never opening the mic', async () => {
    let resolvePrepare!: () => void;
    h.prepare.mockReturnValueOnce(new Promise<void>((r) => (resolvePrepare = r)));
    const ref = renderVoiceCapture();

    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = ref.current.startRecording();
      await flush();
    });

    await act(async () => {
      ref.current.reset();
    });

    await act(async () => {
      resolvePrepare();
      await startPromise;
    });

    expect(h.record).not.toHaveBeenCalled();
    expect(ref.current.phase).toBe('idle');
  });
});
