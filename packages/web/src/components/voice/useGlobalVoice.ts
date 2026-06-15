import { useState, useRef, useCallback, useEffect } from 'react';
import { apiFetch } from '../../utils/api-fetch';

export type VoicePhase = 'idle' | 'recording' | 'uploading' | 'transcribing' | 'transcript';

const VOICE_POLL_INTERVAL_MS = 1500;
const VOICE_POLL_TIMEOUT_MS = 90000;

export function getSupportedAudioMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

export async function createSignedAudioUpload(blob: Blob) {
  const filename = `voice-${Date.now()}.${blob.type.includes('mp4') ? 'm4a' : 'webm'}`;
  const contentType = (blob.type || 'audio/webm').split(';')[0].trim();
  const body = JSON.stringify({
    filename,
    contentType,
    sizeBytes: blob.size,
    entityType: 'voice_recording',
  });

  const requestSigned = async (url: string) =>
    apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

  let response = await requestSigned('/api/files/upload-url');
  if (!response.ok) {
    response = await requestSigned('/api/files/upload');
  }
  if (!response.ok) {
    throw new Error('Unable to get a signed upload URL.');
  }

  const payload = await response.json();
  const fileId = payload.fileId ?? payload.fileRecord?.id;
  const uploadUrl = payload.uploadUrl;
  const audioUrl = payload.audioUrl ?? payload.downloadUrl ?? payload.fileUrl;

  if (!fileId || !uploadUrl) {
    throw new Error('Upload URL response is missing required fields.');
  }

  const uploadResult = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: blob,
  });

  if (!uploadResult.ok) {
    throw new Error('Audio upload failed. Please retry.');
  }

  return { fileId, audioUrl: audioUrl ?? uploadUrl.split('?')[0] };
}

async function pollRecordingUntilDone(recordingId: string) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < VOICE_POLL_TIMEOUT_MS) {
    const res = await apiFetch(`/api/voice/recordings/${recordingId}`, { method: 'GET' });
    if (!res.ok) throw new Error('Could not fetch transcription status.');

    const status = await res.json();
    if (status.status === 'completed') return status;
    if (status.status === 'failed') {
      throw new Error(status.errorMessage || 'Transcription failed.');
    }

    await new Promise((resolve) => setTimeout(resolve, VOICE_POLL_INTERVAL_MS));
  }

  throw new Error('Transcription timed out. Please retry.');
}

export interface PageVoiceContext {
  route: string;
  entityType?: string;
  entityId?: string;
}

export interface UseGlobalVoiceResult {
  phase: VoicePhase;
  transcript: string;
  error: string | null;
  canRetry: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  reset: () => void;
  setTranscript: (value: string) => void;
}

export function useGlobalVoice(): UseGlobalVoiceResult {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stoppingRef = useRef(false);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const uploadAndTranscribe = useCallback(async (audioBlob: Blob) => {
    const { fileId, audioUrl } = await createSignedAudioUpload(audioBlob);
    const idempotencyKey =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `voice-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const createRes = await apiFetch('/api/voice/recordings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId, audioUrl, idempotencyKey }),
    });
    if (!createRes.ok) throw new Error('Unable to start transcription.');

    const created = await createRes.json();
    const recordingId = created.recording?.id;
    if (!recordingId) throw new Error('Missing recording id from API.');

    const completed = await pollRecordingUntilDone(recordingId);
    return (completed.transcript || '').trim();
  }, []);

  const stopRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'recording' || stoppingRef.current) return;

    stoppingRef.current = true;
    setPhase('transcribing');

    await new Promise<void>((resolve) => {
      recorder.onstop = () => {
        const audioBlob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        stopStream();

        if (!audioBlob.size) {
          setError('No audio captured. Please retry.');
          setCanRetry(true);
          setPhase('idle');
          stoppingRef.current = false;
          resolve();
          return;
        }

        void uploadAndTranscribe(audioBlob)
          .then((text) => {
            if (!text) {
              setError('No transcript was returned. Please retry.');
              setCanRetry(true);
              setPhase('idle');
            } else {
              setTranscript(text);
              setPhase('transcript');
            }
          })
          .catch((err) => {
            setError(err instanceof Error ? err.message : 'Transcription failed.');
            setCanRetry(true);
            setPhase('idle');
          })
          .finally(() => {
            stoppingRef.current = false;
            resolve();
          });
      };
      recorder.stop();
    });
  }, [stopStream, uploadAndTranscribe]);

  const startRecording = useCallback(async () => {
    setError(null);
    setCanRetry(false);
    setTranscript('');

    const mimeType = getSupportedAudioMimeType();
    if (!mimeType) {
      setError('This browser does not support a compatible recording format.');
      setCanRetry(true);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      stoppingRef.current = false;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onerror = () => {
        stopStream();
        setError('Recording failed. Please retry.');
        setCanRetry(true);
        setPhase('idle');
      };

      recorder.start(1000);
      setPhase('recording');
    } catch {
      setError('Microphone permission is required to record voice messages.');
      setCanRetry(true);
      setPhase('idle');
      stopStream();
    }
  }, [stopStream]);

  const reset = useCallback(() => {
    setPhase('idle');
    setTranscript('');
    setError(null);
    setCanRetry(false);
  }, []);

  useEffect(
    () => () => {
      const recorder = mediaRecorderRef.current;
      if (recorder?.state === 'recording') recorder.stop();
      stopStream();
    },
    [stopStream],
  );

  return {
    phase,
    transcript,
    error,
    canRetry,
    startRecording,
    stopRecording,
    reset,
    setTranscript,
  };
}

export function derivePageVoiceContext(pathname: string): PageVoiceContext {
  const route = pathname;
  const jobMatch = pathname.match(/^\/jobs\/([^/]+)/);
  if (jobMatch) {
    return { route, entityType: 'job', entityId: jobMatch[1] };
  }
  const customerMatch = pathname.match(/^\/customers\/([^/]+)/);
  if (customerMatch) {
    return { route, entityType: 'customer', entityId: customerMatch[1] };
  }
  const invoiceMatch = pathname.match(/^\/invoices\/([^/]+)/);
  if (invoiceMatch) {
    return { route, entityType: 'invoice', entityId: invoiceMatch[1] };
  }
  return { route };
}
