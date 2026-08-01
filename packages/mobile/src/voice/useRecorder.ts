/**
 * U13 — shared hold-to-talk recorder state machine, extracted from
 * useVoiceCapture so both the owner-capture pipeline and the conversational
 * assistant reuse one tested recorder (no duplicated mic-race handling).
 *
 * Hold-to-talk has a race: a release (onPressOut) can fire before
 * startRecording()'s async permission/prepare resolves. We track the real
 * recorder state in a ref plus a deferred-stop flag so a too-early release
 * either cancels the start (before record()) or, once recording, takes the
 * normal stop path — the mic is never left recording without a matching stop.
 *
 * This owns ONLY the recorder; transcription / upload / TTS live in the
 * consumers, which decide what to do with the returned file URI.
 */

import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import { useCallback, useRef } from 'react';

/** Outcome of a start attempt. */
export type RecorderStartOutcome =
  | 'recording' // mic is open
  | 'cancelled' // released/cancelled before record() began — mic never opened
  | 'denied' // microphone permission denied
  | 'error' // could not start recording
  | 'busy'; // a start/record was already in progress — no-op

export interface UseRecorder {
  /** Begin recording. Never throws. */
  startRecording: () => Promise<RecorderStartOutcome>;
  /**
   * Stop an active recording and return its file URI. During an in-flight
   * start it requests a deferred cancel and resolves null (the start unwinds
   * itself); when idle it resolves null.
   */
  stopRecording: () => Promise<string | null>;
  /** Abort a start-in-flight or discard an active recording without a URI. */
  cancel: () => void;
}

export function useRecorder(): UseRecorder {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recStateRef = useRef<'idle' | 'starting' | 'recording'>('idle');
  const stopRequestedRef = useRef(false);

  const startRecording = useCallback(async (): Promise<RecorderStartOutcome> => {
    if (recStateRef.current !== 'idle') return 'busy';
    recStateRef.current = 'starting';
    stopRequestedRef.current = false;
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        recStateRef.current = 'idle';
        return 'denied';
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();

      if (stopRequestedRef.current) {
        // Released before we finished starting — never record. The recorder is
        // already prepared, so reset it; otherwise the next press calls
        // prepareToRecordAsync() on a still-prepared recorder and hold-to-talk
        // sticks on "Could not start recording" until a remount.
        recStateRef.current = 'idle';
        try {
          await recorder.stop();
        } catch {
          // wasn't recording — nothing to stop
        }
        return 'cancelled';
      }

      recorder.record();
      recStateRef.current = 'recording';
      return 'recording';
    } catch {
      recStateRef.current = 'idle';
      return 'error';
    }
  }, [recorder]);

  const stopRecording = useCallback(async (): Promise<string | null> => {
    if (recStateRef.current === 'starting') {
      // startRecording() will see this flag and unwind once it finishes.
      stopRequestedRef.current = true;
      return null;
    }
    if (recStateRef.current !== 'recording') return null;
    recStateRef.current = 'idle';
    try {
      await recorder.stop();
    } catch {
      // ignore — the consumer handles a missing/empty uri
    }
    return recorder.uri;
  }, [recorder]);

  const cancel = useCallback(() => {
    // Safe mid-capture: abort a pending start via the deferred-stop flag
    // (startRecording cancels before record()); stop and discard an active one.
    if (recStateRef.current === 'starting') {
      stopRequestedRef.current = true;
    } else if (recStateRef.current === 'recording') {
      recStateRef.current = 'idle';
      void recorder.stop().catch(() => {});
    }
  }, [recorder]);

  return { startRecording, stopRecording, cancel };
}
