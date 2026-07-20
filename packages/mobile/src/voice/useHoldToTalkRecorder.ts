import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import { useCallback, useRef } from 'react';

/**
 * Callbacks are read through a ref, so consumers may pass fresh closures each
 * render without destabilizing the press handlers.
 */
export interface HoldToTalkCallbacks {
  /** Fired once a press actually begins starting (after the idle guard). */
  onStarting?: () => void;
  /** The mic is live. */
  onListening: () => void;
  /** An early release cancelled the start before recording began. */
  onCancelled: () => void;
  /** Release with a recording — awaited, so pressOut resolves after handling. */
  onClip: (uri: string | null) => Promise<void> | void;
  onPermissionDenied: () => void;
  onStartError: () => void;
}

export interface UseHoldToTalkRecorderResult {
  /** Press-in: request permission, prepare, record. */
  pressIn: () => Promise<void>;
  /** Release: stop + hand the clip to onClip (or defer if still starting). */
  pressOut: () => Promise<void>;
  /** Abort a pending start or discard an active recording (no onClip). */
  cancel: () => void;
}

/**
 * The hold-to-talk recorder state machine, extracted from `useVoiceCapture`
 * (U13) so the conversational assistant shares one tested recorder instead of
 * duplicating the race handling.
 *
 * The race: a release (onPressOut) can fire before pressIn's async
 * permission/prepare resolves. The real recorder state lives in a ref plus a
 * deferred-stop flag, so a too-early release either cancels the start (before
 * record()) or, once recording, takes the normal stop path — never leaving
 * the mic recording with no matching stop.
 */
export function useHoldToTalkRecorder(callbacks: HoldToTalkCallbacks): UseHoldToTalkRecorderResult {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recStateRef = useRef<'idle' | 'starting' | 'recording'>('idle');
  const stopRequestedRef = useRef(false);
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const doStop = useCallback(async () => {
    recStateRef.current = 'idle';
    try {
      await recorder.stop();
    } catch {
      // ignore — onClip handles a missing/empty uri
    }
    await cbRef.current.onClip(recorder.uri);
  }, [recorder]);

  const pressIn = useCallback(async () => {
    if (recStateRef.current !== 'idle') return;
    recStateRef.current = 'starting';
    stopRequestedRef.current = false;
    cbRef.current.onStarting?.();
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        recStateRef.current = 'idle';
        cbRef.current.onPermissionDenied();
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();

      if (stopRequestedRef.current) {
        // Released before we finished starting — never record. The recorder is
        // already prepared, though, so reset it; otherwise the next press calls
        // prepareToRecordAsync() on a still-prepared recorder and hold-to-talk
        // sticks on "Could not start recording" until a remount.
        recStateRef.current = 'idle';
        try {
          await recorder.stop();
        } catch {
          // wasn't recording — nothing to stop
        }
        cbRef.current.onCancelled();
        return;
      }

      recorder.record();
      recStateRef.current = 'recording';
      cbRef.current.onListening();
    } catch {
      recStateRef.current = 'idle';
      cbRef.current.onStartError();
    }
  }, [recorder]);

  const pressOut = useCallback(async () => {
    if (recStateRef.current === 'starting') {
      // pressIn() will see this flag and cancel once it finishes.
      stopRequestedRef.current = true;
      return;
    }
    if (recStateRef.current !== 'recording') return;
    await doStop();
  }, [doStop]);

  const cancel = useCallback(() => {
    // Must be safe mid-capture: abort a pending start via the deferred-stop
    // flag (pressIn cancels before record()); stop and discard an active
    // recording without invoking onClip.
    if (recStateRef.current === 'starting') {
      stopRequestedRef.current = true;
    } else if (recStateRef.current === 'recording') {
      recStateRef.current = 'idle';
      void recorder.stop().catch(() => {});
    }
  }, [recorder]);

  return { pressIn, pressOut, cancel };
}
