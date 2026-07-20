import * as FileSystem from 'expo-file-system';
import { useCallback, useState } from 'react';
import { useApiClient } from '../lib/useApiClient';
import { isCurrentlyOnline } from '../lib/connectivity';
import { relocateAudioForQueue } from '../offline/audioRelocation';
import { nativeAudioRelocationDeps } from '../offline/nativeOfflineDeps';
import { getOfflineQueue } from '../offline/queueInstance';
import { makeIdempotencyKey, uploadFile } from './nativeVoiceDeps';
import { uploadAndTranscribe, type AudioClip } from './uploadAndTranscribe';
import { useHoldToTalkRecorder } from './useHoldToTalkRecorder';
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
 * automatically and appear in the approvals inbox. The press-race handling
 * lives in the shared `useHoldToTalkRecorder` (U13 extraction — the
 * conversational assistant records through the same machine).
 */
export function useVoiceCapture(jobId?: string): UseVoiceCaptureResult {
  const api = useApiClient();
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

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

  const recorder = useHoldToTalkRecorder({
    onStarting: () => {
      setError(null);
      setTranscript('');
    },
    onListening: () => setPhase('listening'),
    onCancelled: () => setPhase('idle'),
    onClip: (uri) => transcribe(uri),
    onPermissionDenied: () => {
      setError(MIC_PERMISSION_COPY.body);
      setPhase('error');
    },
    onStartError: () => {
      setError('Could not start recording. Please retry.');
      setPhase('error');
    },
  });

  const startRecording = recorder.pressIn;
  const stopAndTranscribe = recorder.pressOut;

  const reset = useCallback(() => {
    // Must be safe mid-capture: abort a pending start / discard an active
    // recording without transcribing (the recorder's cancel handles the race).
    recorder.cancel();
    setPhase('idle');
    setTranscript('');
    setError(null);
  }, [recorder]);

  return { phase, transcript, error, startRecording, stopAndTranscribe, reset };
}
