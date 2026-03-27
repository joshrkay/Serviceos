'use client';

import { useState, useRef, useCallback } from 'react';

interface UseDeepgramSTTReturn {
  transcript: string;
  interimTranscript: string;
  isRecording: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  error: string | null;
}

export function useDeepgramSTT(): UseDeepgramSTTReturn {
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const cleanup = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      // Send close message to Deepgram
      wsRef.current.send(JSON.stringify({ type: 'CloseStream' }));
      wsRef.current.close();
    }
    wsRef.current = null;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    setTranscript('');
    setInterimTranscript('');

    // 1. Get mic permission
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
    } catch {
      setError('Microphone access denied');
      return;
    }

    // 2. Get temp token
    let token: string;
    try {
      const res = await fetch('/api/deepgram-token');
      if (!res.ok) throw new Error('Token fetch failed');
      const data = await res.json();
      token = data.token;
    } catch {
      setError('Could not get Deepgram token');
      cleanup();
      return;
    }

    // 3. Open WebSocket
    const params = new URLSearchParams({
      model: 'nova-3',
      smart_format: 'true',
      interim_results: 'true',
      vad_events: 'true',
      endpointing: '2000',
    });

    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', token]);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsRecording(true);

      // Start MediaRecorder and stream audio chunks
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(e.data);
        }
      };

      recorder.start(250); // send chunks every 250ms
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'Results' && data.channel?.alternatives?.[0]) {
          const alt = data.channel.alternatives[0];
          const text = alt.transcript || '';
          if (data.is_final) {
            setTranscript(prev => (prev ? `${prev} ${text}` : text));
            setInterimTranscript('');
          } else {
            setInterimTranscript(text);
          }
        }
      } catch (e) {
        console.warn('Could not parse Deepgram message:', e);
      }
    };

    ws.onerror = () => {
      setError('Connection error');
      setIsRecording(false);
      cleanup();
    };

    ws.onclose = () => {
      setIsRecording(false);
    };
  }, [cleanup]);

  const stopRecording = useCallback(() => {
    setIsRecording(false);
    setInterimTranscript('');
    cleanup();
  }, [cleanup]);

  return { transcript, interimTranscript, isRecording, startRecording, stopRecording, error };
}
