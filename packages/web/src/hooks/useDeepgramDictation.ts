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
 * A2 — the WS previously carried neither a language pin nor any keyterm
 * boosting, unlike every other STT surface in the voice pipeline. `opts.
 * language` threads the operator's session/tenant language onto both the
 * `/stream-token` mint call (audit parity with the `/transcribe` route's
 * `languageHint` pattern) and the Deepgram WS URL itself. `opts.keyterms`
 * threads Nova-3 keyterm boosting (same param `transcription-providers.ts`
 * emits for telephony) when the caller has terms to offer; the token route
 * itself has no tenant-glossary/vertical repo access today, so sourcing a
 * default keyterm list server-side is a follow-up — see A2 notes.
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

function buildStreamUrl(
  model: string,
  opts: {
    utteranceEndMs?: number;
    /** A2 — pins Deepgram's recognition language; omitted lets Deepgram auto-detect. */
    language?: 'en' | 'es';
    /** A2 — Nova-3 keyterm prompting; repeated `keyterm=` params (same shape transcription-providers.ts emits for telephony). */
    keyterms?: ReadonlyArray<string>;
  } = {},
): string {
  const params = new URLSearchParams({
    model: model || 'nova-3',
    interim_results: 'true',
    punctuate: 'true',
    smart_format: 'true',
  });
  // UB-B2 — conversation mode: ask Deepgram to emit UtteranceEnd events after
  // this much trailing silence so per-utterance finals fire while the mic
  // stays open (requires interim_results, which is already pinned above).
  if (opts.utteranceEndMs !== undefined) {
    params.set('utterance_end_ms', String(opts.utteranceEndMs));
    params.set('vad_events', 'true');
  }
  if (opts.language) {
    params.set('language', opts.language);
  }
  if (opts.keyterms) {
    for (const term of opts.keyterms) {
      if (term) params.append('keyterm', term);
    }
  }
  return `${DEEPGRAM_WS_BASE}?${params.toString()}`;
}

export function useDeepgramDictation(opts: {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  /**
   * UB-B2 — continuous conversation mode. When set, each utterance's final
   * text is delivered HERE as it completes (Deepgram `speech_final` /
   * `UtteranceEnd`) while the mic stays open; the accumulated-finals buffer
   * resets per utterance. Existing stop-to-finalize callers are untouched:
   * without this option the hook behaves exactly as before.
   */
  onUtteranceEnd?: (text: string) => void;
  /** Trailing-silence window (ms) for UtteranceEnd events. Default 1000. */
  utteranceEndMs?: number;
  /**
   * A2 — the operator's session/tenant language. Threaded onto both the
   * `/stream-token` mint call (query param, audit parity with `/transcribe`'s
   * `languageHint`) and the Deepgram WS URL. Omitted (Deepgram auto-detect)
   * when the caller doesn't know it.
   */
  language?: 'en' | 'es';
  /**
   * A2 — Nova-3 keyterm boost terms (e.g. tenant catalog/customer/technician
   * names). Purely a pass-through: the caller is responsible for sourcing
   * the list (the `/stream-token` route has no tenant-glossary/vertical
   * repo access today — see the module doc comment).
   */
  keyterms?: ReadonlyArray<string>;
}): UseDeepgramDictation {
  // Keep the latest callbacks in refs so `start`/`stop` keep a stable identity
  // even when the caller passes a fresh `opts` object literal on every render
  // (otherwise they'd churn and defeat memoization in consumers/effects).
  const onPartialRef = useRef(opts.onPartial);
  const onFinalRef = useRef(opts.onFinal);
  const onUtteranceEndRef = useRef(opts.onUtteranceEnd);
  onPartialRef.current = opts.onPartial;
  onFinalRef.current = opts.onFinal;
  onUtteranceEndRef.current = opts.onUtteranceEnd;
  // Mirrored into refs so the stable `start` callback sees the live values.
  const continuousRef = useRef(false);
  const utteranceEndMsRef = useRef<number | undefined>(undefined);
  continuousRef.current = opts.onUtteranceEnd !== undefined;
  utteranceEndMsRef.current = continuousRef.current ? (opts.utteranceEndMs ?? 1000) : undefined;
  // A2 — language/keyterms mirrored the same way so `start` (a stable
  // callback) always reads the latest values without being in its own
  // dependency array.
  const languageRef = useRef<'en' | 'es' | undefined>(opts.language);
  const keytermsRef = useRef<ReadonlyArray<string> | undefined>(opts.keyterms);
  languageRef.current = opts.language;
  keytermsRef.current = opts.keyterms;

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

  // UB-B2 — continuous mode: deliver the utterance accumulated so far and
  // reset the buffers so the next utterance starts clean while the mic stays
  // open. No-op when nothing final has been committed yet.
  const flushUtterance = useCallback(() => {
    const text = finalsRef.current.join(' ').replace(/\s+/g, ' ').trim();
    finalsRef.current = [];
    interimRef.current = '';
    setPartial('');
    if (text) onUtteranceEndRef.current?.(text);
  }, []);

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
      // A2 — thread the session/tenant language onto the mint call so the
      // server-side audit trail (voice.stream_token_minted/_failed) records
      // it, mirroring /transcribe's `languageHint` query param.
      const tokenQs = languageRef.current ? `?language=${encodeURIComponent(languageRef.current)}` : '';
      const res = await apiFetch(`/api/voice/stream-token${tokenQs}`, { method: 'POST' });
      if (!res.ok) {
        let serverMessage: string | undefined;
        try {
          const body = (await res.json()) as { message?: string };
          serverMessage = typeof body.message === 'string' ? body.message : undefined;
        } catch {
          /* ignore non-JSON error bodies */
        }
        setError(
          res.status === 503
            ? (serverMessage ?? 'Live transcription is not available right now.')
            : (serverMessage ?? 'Could not start dictation. Please try again.'),
        );
        return;
      }
      const { token, model } = (await res.json()) as StreamTokenResponse;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Deepgram browser auth: pass the short-lived token via the `bearer`
      // WebSocket subprotocol (browsers can't set Authorization headers on WS).
      const ws = new WebSocket(
        buildStreamUrl(model, {
          utteranceEndMs: utteranceEndMsRef.current,
          language: languageRef.current,
          keyterms: keytermsRef.current,
        }),
        ['bearer', token],
      );
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
          type?: string;
          channel?: { alternatives?: Array<{ transcript?: string }> };
          is_final?: boolean;
          speech_final?: boolean;
        };
        // UB-B2 — Deepgram's UtteranceEnd event (only requested in continuous
        // mode): the trailing-silence window elapsed, so whatever finals have
        // accumulated form a complete utterance.
        if (continuousRef.current && d.type === 'UtteranceEnd') {
          flushUtterance();
          return;
        }
        const transcript = d.channel?.alternatives?.[0]?.transcript ?? '';
        if (!transcript) return;
        if (d.is_final) {
          finalsRef.current.push(transcript);
          interimRef.current = '';
          // speech_final marks Deepgram's endpointing decision — the fast
          // path for a completed utterance (UtteranceEnd is the fallback for
          // finals that arrive without it).
          if (continuousRef.current && d.speech_final) {
            flushUtterance();
            return;
          }
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
  }, [isRecording, cleanup, composed, flushUtterance]);

  // Tear down on unmount so a mic/WS never leaks past the component.
  useEffect(() => () => cleanup(), [cleanup]);

  return { isRecording, partial, error, supported: dictationSupported(), start, stop };
}
