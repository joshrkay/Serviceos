import { useState, useCallback, useRef, useEffect } from 'react';

export type RecordingState = 'idle' | 'recording' | 'stopped' | 'uploading' | 'transcribing';

export const MAX_BLOB_SIZE = 50 * 1024 * 1024; // 50MB
export const MAX_DURATION_SECONDS = 1800; // 30 minutes

export interface UseVoiceRecorderResult {
  state: RecordingState;
  duration: number;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  reRecord: () => void;
  getBlob: () => Blob | null;
  upload: (onUpload: (blob: Blob) => Promise<void>) => Promise<void>;
}

export function useVoiceRecorder(): UseVoiceRecorderResult {
  const [state, setState] = useState<RecordingState>('idle');
  const [duration, setDuration] = useState(0);
  const blobRef = useRef<Blob | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      stopStream();
      clearTimer();
    };
  }, [stopStream, clearTimer]);

  const start = useCallback(async () => {
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      blobRef.current = null;
      setDuration(0);

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        blobRef.current = blob;
        stopStream();
        clearTimer();
      };

      recorder.onerror = () => {
        stopStream();
        clearTimer();
        setState('idle');
      };

      recorder.start();
      setState('recording');

      timerRef.current = setInterval(() => {
        setDuration((d) => {
          if (d + 1 >= MAX_DURATION_SECONDS) {
            if (mediaRecorderRef.current?.state === 'recording') {
              mediaRecorderRef.current.stop();
              setState('stopped');
            }
            return d + 1;
          }
          return d + 1;
        });
      }, 1000);
    } catch {
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
      streamRef.current = null;
      setState('idle');
    }
  }, [clearTimer, stopStream]);

  const stop = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
      setState('stopped');
    }
  }, []);

  const cancel = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    stopStream();
    blobRef.current = null;
    chunksRef.current = [];
    setDuration(0);
    clearTimer();
    setState('idle');
  }, [clearTimer, stopStream]);

  const reRecord = useCallback(() => {
    blobRef.current = null;
    chunksRef.current = [];
    setDuration(0);
    setState('idle');
  }, []);

  const getBlob = useCallback(() => blobRef.current, []);

  const upload = useCallback(async (onUpload: (blob: Blob) => Promise<void>) => {
    const blob = blobRef.current;
    if (!blob || blob.size === 0) return;

    if (blob.size > MAX_BLOB_SIZE) {
      throw new Error(`Recording exceeds maximum size of ${MAX_BLOB_SIZE} bytes`);
    }

    setState('uploading');
    try {
      await onUpload(blob);
      setState('transcribing');
    } catch {
      setState('stopped');
    }
  }, []);

  return { state, duration, start, stop, cancel, reRecord, getBlob, upload };
}
