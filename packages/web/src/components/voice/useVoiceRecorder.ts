import { useState, useCallback, useRef } from 'react';

export type RecordingState = 'idle' | 'recording' | 'stopped' | 'uploading' | 'transcribing';

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
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
        stream.getTracks().forEach((t) => t.stop());
        clearTimer();
      };

      recorder.start();
      setState('recording');

      timerRef.current = setInterval(() => {
        setDuration((d) => d + 1);
      }, 1000);
    } catch {
      setState('idle');
    }
  }, [clearTimer]);

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
    blobRef.current = null;
    chunksRef.current = [];
    setDuration(0);
    clearTimer();
    setState('idle');
  }, [clearTimer]);

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
