import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system';
import { useCallback, useState } from 'react';
import { useApiClient } from '../lib/useApiClient';
import { makeIdempotencyKey, uploadFile } from './nativeVoiceDeps';
import { uploadAndTranscribe, type AudioClip } from './uploadAndTranscribe';

export type VoicePhase = 'idle' | 'listening' | 'transcribing' | 'transcript' | 'error';

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
 * automatically and appear in the approvals inbox (a later unit surfaces them).
 */
export function useVoiceCapture(): UseVoiceCaptureResult {
  const api = useApiClient();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const startRecording = useCallback(async () => {
    setError(null);
    setTranscript('');
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setError('Microphone permission is required to record.');
        setPhase('error');
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setPhase('listening');
    } catch {
      setError('Could not start recording. Please retry.');
      setPhase('error');
    }
  }, [recorder]);

  const stopAndTranscribe = useCallback(async () => {
    if (phase !== 'listening') return;
    setPhase('transcribing');
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) throw new Error('No audio captured. Please retry.');
      const info = await FileSystem.getInfoAsync(uri);
      const sizeBytes = info.exists ? (info.size ?? 0) : 0;
      if (!sizeBytes) throw new Error('No audio captured. Please retry.');

      const clip: AudioClip = { fileUri: uri, contentType: 'audio/mp4', sizeBytes };
      const text = await uploadAndTranscribe(clip, { api, uploadFile, makeIdempotencyKey });
      if (!text) throw new Error('No transcript was returned. Please retry.');

      setTranscript(text);
      setPhase('transcript');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transcription failed.');
      setPhase('error');
    }
  }, [api, phase, recorder]);

  const reset = useCallback(() => {
    setPhase('idle');
    setTranscript('');
    setError(null);
  }, []);

  return { phase, transcript, error, startRecording, stopAndTranscribe, reset };
}
