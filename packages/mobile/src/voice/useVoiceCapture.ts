import * as FileSystem from 'expo-file-system';
import { useCallback, useState } from 'react';
import { useApiClient } from '../lib/useApiClient';
import { isCurrentlyOnline } from '../lib/connectivity';
import { getOfflineQueue } from '../offline/offlineQueue';
import { makeIdempotencyKey, uploadFile } from './nativeVoiceDeps';
import { useRecorder } from './useRecorder';
import {
  uploadAndTranscribe,
  type AudioClip,
  type VoiceRoutedOutcome,
} from './uploadAndTranscribe';
import { MIC_PERMISSION_COPY } from '../lib/errorCopy';

export type VoicePhase =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'transcript'
  // U12 — captured offline: the clip was journaled and will upload on reconnect.
  | 'queued'
  | 'error';

export interface UseVoiceCaptureResult {
  phase: VoicePhase;
  transcript: string;
  /** U3 — routed outcome from the bounded second poll; null until landed. */
  outcome: VoiceRoutedOutcome | null;
  error: string | null;
  /** Begin recording (press-in on the mic). */
  startRecording: () => Promise<void>;
  /** Stop + upload + transcribe (release). */
  stopAndTranscribe: () => Promise<void>;
  reset: () => void;
}

/**
 * Hold-to-talk capture: record (shared useRecorder state machine) →
 * upload+transcribe (the tested RN-free pipeline) → expose the transcript.
 * Proposals are created server-side automatically and appear in the approvals
 * inbox.
 */
export function useVoiceCapture(jobId?: string): UseVoiceCaptureResult {
  const api = useApiClient();
  const recorder = useRecorder();
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [transcript, setTranscript] = useState('');
  const [outcome, setOutcome] = useState<VoiceRoutedOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const transcribe = useCallback(
    async (uri: string | null) => {
      setPhase('transcribing');
      try {
        if (!uri) throw new Error('No audio captured. Please retry.');
        const info = await FileSystem.getInfoAsync(uri);
        const sizeBytes = info.exists ? (info.size ?? 0) : 0;
        if (!sizeBytes) throw new Error('No audio captured. Please retry.');

        const clip: AudioClip = { fileUri: uri, contentType: 'audio/mp4', sizeBytes };

        // U12 — offline: journal the clip (moving it out of the evictable cache
        // dir) and let the flush machine upload it on reconnect. No proposal
        // round-trip now; the owner sees a "saved, will send" state.
        if (!isCurrentlyOnline()) {
          await getOfflineQueue().enqueueVoice({
            sourceUri: uri,
            contentType: clip.contentType,
            sizeBytes,
            ...(jobId ? { jobId } : {}),
          });
          setPhase('queued');
          return;
        }

        const result = await uploadAndTranscribe(
          clip,
          { api, uploadFile, makeIdempotencyKey },
          jobId,
        );
        if (!result.transcript) throw new Error('No transcript was returned. Please retry.');

        setTranscript(result.transcript);
        setOutcome(result.outcome);
        setPhase('transcript');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Transcription failed.');
        setPhase('error');
      }
    },
    [api, jobId],
  );

  const startRecording = useCallback(async () => {
    setError(null);
    setTranscript('');
    setOutcome(null);
    const outcome = await recorder.startRecording();
    if (outcome === 'recording') {
      setPhase('listening');
    } else if (outcome === 'denied') {
      setError(MIC_PERMISSION_COPY.body);
      setPhase('error');
    } else if (outcome === 'error') {
      setError('Could not start recording. Please retry.');
      setPhase('error');
    } else {
      // 'cancelled' (released before record() began) or 'busy' — stay idle.
      if (outcome === 'cancelled') setPhase('idle');
    }
  }, [recorder]);

  const stopAndTranscribe = useCallback(async () => {
    const uri = await recorder.stopRecording();
    // null = deferred cancel (released mid-start) or not recording — nothing to do.
    if (uri === null) return;
    await transcribe(uri);
  }, [recorder, transcribe]);

  const reset = useCallback(() => {
    // reset() must be safe mid-capture: the machine is otherwise only advanced
    // by press-in/release, so without this a reset during an in-flight start
    // could later resume into a live mic. The recorder cancels a pending start
    // or discards an active recording without transcribing.
    recorder.cancel();
    setPhase('idle');
    setTranscript('');
    setOutcome(null);
    setError(null);
  }, [recorder]);

  return { phase, transcript, outcome, error, startRecording, stopAndTranscribe, reset };
}
