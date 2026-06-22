import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api-fetch';

/**
 * Story 3.2 — live voice dictation streamed to Deepgram Nova-3.
 *
 * Flow:
 *   1. Ask our API for a 30s grant token (POST /api/voice/stream-token). The
 *      long-lived DEEPGRAM_API_KEY never reaches the browser.
 *   2. Open a WebSocket straight to Deepgram with that short-lived token,
 *      authenticated via the `bearer` subprotocol (no custom headers, which
 *      browsers can't set on a WebSocket).
 *   3. Stream mic audio (MediaRecorder webm/opus chunks); Deepgram sniffs the
 *      container, so no encoding/sample_rate is pinned (unlike the linear16
 *      telephony path).
 *   4. Interim results update `partial` live; finalized segments accumulate and
 *      are delivered to the agent via `onFinal` when recording stops.
 *
 * The hook is defensive: every browser API it touches is feature-detected and
 * mockable, so it unit-tests in jsdom.
 */

const DEEPGRAM_WS_BASE = 'wss://api.deepgram.com/v1/listen';

interface StreamTokenResponse {
  token: string;
  expiresIn: number;
  model: string;
}

export interface UseDeepgramDictation {
  isRecording: boolean;
  /** Live interim text (committed finals + the current interim segment). */
  partial: string;
  error: string | null;
  supported: boolean;
  start: () => Promise<void>;
  stop: () => void;
}

export function dictationSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined' &&
    typeof WebSocket !== 'undefined'
  );
}

function buildStreamUrl(model: string): string {
  const params = new URLSearchParams({
    model: model || 'nova-3',
    interim_results: 'true',
    punctuate: 'true',
    smart_format: 'true',
  });
  return `${DEEPGRAM_WS_BASE}?${params.toString()}`;
}

export function useDeepgramDictation(opts: {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
}): UseDeepgramDictation {
  // Keep the latest callbacks in refs so `start`/`stop` keep a stable identity
  // even when the caller passes a fresh `opts` object literal on every render
  // (otherwise they'd churn and defeat memoization in consumers/effects).
  const onPartialRef = useRef(opts.onPartial);
  const onFinalRef = useRef(opts.onFinal);
  onPartialRef.current = opts.onPartial;
  onFinalRef.current = opts.onFinal;

  const [isRecording, setIsRecording] = useState(false);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const finalsRef = useRef<string[]>([]);
  const interimRef = useRef('');

  const cleanup = useCallback(() => {
    try {
      recorderRef.current?.state === 'recording' && recorderRef.current.stop();
    } catch {
      /* recorder already stopped */
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    try {
      wsRef.current?.close();
    } catch {
      /* ws already closing */
    }
    wsRef.current = null;
  }, []);

  const composed = useCallback(
    () => [...finalsRef.current, interimRef.current].join(' ').replace(/\s+/g, ' ').trim(),
    [],
  );

  const stop = useCallback(() => {
    if (!recorderRef.current && !wsRef.current) return;
    // Flush Deepgram, then deliver the accumulated final transcript.
    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'CloseStream' }));
      }
    } catch {
      /* best-effort flush */
    }
    cleanup();
    setIsRecording(false);
    const finalText = composed();
    interimRef.current = '';
    if (finalText) onFinalRef.current?.(finalText);
  }, [cleanup, composed]);

  const start = useCallback(async () => {
    if (isRecording) return;
    setError(null);
    finalsRef.current = [];
    interimRef.current = '';
    setPartial('');

    if (!dictationSupported()) {
      setError('Voice dictation is not supported in this browser.');
      return;
    }

    try {
      const res = await apiFetch('/api/voice/stream-token', { method: 'POST' });
      if (!res.ok) {
        setError(
          res.status === 503
            ? 'Live transcription is not available right now.'
            : 'Could not start dictation. Please try again.',
        );
        return;
      }
      const { token, model } = (await res.json()) as StreamTokenResponse;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Deepgram browser auth: pass the short-lived token via the `bearer`
      // WebSocket subprotocol (browsers can't set Authorization headers on WS).
      const ws = new WebSocket(buildStreamUrl(model), ['bearer', token]);
      wsRef.current = ws;

      ws.onopen = () => {
        const recorder = new MediaRecorder(stream);
        recorderRef.current = recorder;
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) ws.send(e.data);
        };
        recorder.start(250); // ~250ms chunks for low-latency interim results
        setIsRecording(true);
      };

      ws.onmessage = (event) => {
        let data: unknown;
        try {
          data = JSON.parse(typeof event.data === 'string' ? event.data : '');
        } catch {
          return;
        }
        const d = data as {
          channel?: { alternatives?: Array<{ transcript?: string }> };
          is_final?: boolean;
        };
        const transcript = d.channel?.alternatives?.[0]?.transcript ?? '';
        if (!transcript) return;
        if (d.is_final) {
          finalsRef.current.push(transcript);
          interimRef.current = '';
        } else {
          interimRef.current = transcript;
          onPartialRef.current?.(transcript);
        }
        const live = composed();
        setPartial(live);
      };

      ws.onerror = () => {
        setError('Lost the dictation connection. Please try again.');
        cleanup();
        setIsRecording(false);
      };
    } catch (err) {
      setError(
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone permission is required for voice dictation.'
          : 'Could not start dictation. Please try again.',
      );
      cleanup();
      setIsRecording(false);
    }
  }, [isRecording, cleanup, composed]);

  // Tear down on unmount so a mic/WS never leaks past the component.
  useEffect(() => () => cleanup(), [cleanup]);

  return { isRecording, partial, error, supported: dictationSupported(), start, stop };
}
