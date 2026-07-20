import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system';
import { useCallback, useRef, useState } from 'react';
import { useApiClient } from '../lib/useApiClient';
import { isCurrentlyOnline } from '../lib/connectivity';
import { relocateAudioForQueue } from '../offline/audioRelocation';
import { nativeAudioRelocationDeps } from '../offline/nativeOfflineDeps';
import { getOfflineQueue } from '../offline/queueInstance';
import { makeIdempotencyKey, uploadFile } from './nativeVoiceDeps';
import { uploadAndTranscribe, type AudioClip } from './uploadAndTranscribe';
import { MIC_PERMISSION_COPY } from '../lib/errorCopy';

export type VoicePhase = 'idle' | 'listening' | 'transcribing' | 'transcript' | 'queued' | 'error';

/** RN/Hermes transport failure — the request never reached the server. */
function isOfflineFetchError(e: unknown): boolean {
  return e instanceof Error && /network request failed/i.test(e.message);
}

export interface UseVoiceCaptureResult {
  phase: VoicePhase;
  transcript: string;
  error: string | null;
  /** Begin recording (press-in on the mic). */
  startRecording: () => Promise<void>;
  /** Stop + upload + transcribe (release). */
  stopAndTranscribe: () => Promise<void>;
  reset: () => void;
}

/**
 * Hold-to-talk capture: record with expo-audio → upload+transcribe (the tested
 * RN-free pipeline) → expose the transcript. Proposals are created server-side
 * automatically and appear in the approvals inbox.
 *
 * Hold-to-talk has a race: a release (onPressOut) can fire before
 * startRecording()'s async permission/prepare resolves. We track the real
 * recorder state in a ref and a deferred-stop flag so a too-early release
 * either cancels the start (before record()) or, once recording, takes the
 * normal stop path — never leaves the mic recording with no matching stop.
 */
export function useVoiceCapture(jobId?: string): UseVoiceCaptureResult {
  const api = useApiClient();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recStateRef = useRef<'idle' | 'starting' | 'recording'>('idle');
  const stopRequestedRef = useRef(false);

  // U12 — offline capture: a recording is just a file. Move it out of the
  // evictable cache, journal it with a replay key minted ONCE here (U11 server
  // dedup makes every later flush attempt safe), and let the flush machine
  // send it on reconnect. No transcript is shown — the proposal appears in the
  // inbox after the queued item flushes.
  const enqueueOffline = useCallback(
    async (uri: string, sizeBytes: number) => {
      const itemId = makeIdempotencyKey();
      const localUri = await relocateAudioForQueue(nativeAudioRelocationDeps, {
        itemId,
        sourceUri: uri,
      });
      await getOfflineQueue().enqueueVoice({
        id: itemId,
        idempotencyKey: makeIdempotencyKey(),
        enqueuedAt: new Date().toISOString(),
        payload: {
          localUri,
          contentType: 'audio/mp4',
          sizeBytes,
          ...(jobId ? { jobId } : {}),
        },
      });
      setPhase('queued');
    },
    [jobId],
  );

  const transcribe = useCallback(
    async (uri: string | null) => {
      setPhase('transcribing');
      try {
        if (!uri) throw new Error('No audio captured. Please retry.');
        const info = await FileSystem.getInfoAsync(uri);
        const sizeBytes = info.exists ? (info.size ?? 0) : 0;
        if (!sizeBytes) throw new Error('No audio captured. Please retry.');

        if (!isCurrentlyOnline()) {
          await enqueueOffline(uri, sizeBytes);
          return;
        }

        const clip: AudioClip = { fileUri: uri, contentType: 'audio/mp4', sizeBytes };
        let text: string;
        try {
          text = await uploadAndTranscribe(clip, { api, uploadFile, makeIdempotencyKey }, jobId);
        } catch (e) {
          // Connection dropped mid-upload — the clip is still on disk, so
          // queue it instead of failing the capture.
          if (isOfflineFetchError(e)) {
            await enqueueOffline(uri, sizeBytes);
            return;
          }
          throw e;
        }
        if (!text) throw new Error('No transcript was returned. Please retry.');

        setTranscript(text);
        setPhase('transcript');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Transcription failed.');
        setPhase('error');
      }
    },
    [api, enqueueOffline, jobId],
  );

  const doStop = useCallback(async () => {
    recStateRef.current = 'idle';
    try {
      await recorder.stop();
    } catch {
      // ignore — transcribe() catches a missing/empty uri
    }
    await transcribe(recorder.uri);
  }, [recorder, transcribe]);

  const startRecording = useCallback(async () => {
    if (recStateRef.current !== 'idle') return;
    recStateRef.current = 'starting';
    stopRequestedRef.current = false;
    setError(null);
    setTranscript('');
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        recStateRef.current = 'idle';
        setError(MIC_PERMISSION_COPY.body);
        setPhase('error');
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
        setPhase('idle');
        return;
      }

      recorder.record();
      recStateRef.current = 'recording';
      setPhase('listening');
    } catch {
      recStateRef.current = 'idle';
      setError('Could not start recording. Please retry.');
      setPhase('error');
    }
  }, [recorder]);

  const stopAndTranscribe = useCallback(async () => {
    if (recStateRef.current === 'starting') {
      // startRecording() will see this flag and stop once it finishes.
      stopRequestedRef.current = true;
      return;
    }
    if (recStateRef.current !== 'recording') return;
    await doStop();
  }, [doStop]);

  const reset = useCallback(() => {
    // reset() must be safe mid-capture: the machine is otherwise only advanced
    // by press-in/release, so without this a reset during an in-flight start
    // could later resume into a live mic. Abort a pending start via the
    // deferred-stop flag (startRecording cancels before record()); stop and
    // discard an active recording (no transcribe).
    if (recStateRef.current === 'starting') {
      stopRequestedRef.current = true;
    } else if (recStateRef.current === 'recording') {
      recStateRef.current = 'idle';
      void recorder.stop().catch(() => {});
    }
    setPhase('idle');
    setTranscript('');
    setError(null);
  }, [recorder]);

  return { phase, transcript, error, startRecording, stopAndTranscribe, reset };
}
