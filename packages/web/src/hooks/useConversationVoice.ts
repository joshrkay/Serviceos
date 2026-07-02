import { useCallback, useEffect, useRef, useState } from 'react';
import { useDeepgramDictation } from './useDeepgramDictation';
import { useTTS } from './useTTS';

/**
 * UB-B2 — conversational voice mode for the owner assistant.
 *
 * Composes:
 *   - `useDeepgramDictation` in continuous mode (per-utterance finals while
 *     the mic stays open, via Deepgram `utterance_end_ms`),
 *   - `useTTS` (browser speechSynthesis) for spoken replies,
 *   - barge-in: any non-empty partial while the assistant is speaking stops
 *     TTS immediately,
 *   - a continuation debounce (~800ms): an utterance final followed by more
 *     speech within the window concatenates into one submission instead of
 *     firing twice,
 *   - a silence timeout (60s of no speech activity) that ends the session.
 *
 * The composed hook auto-submits each settled utterance through `onSubmit`
 * (the existing chat submit path) — it never routes approvals or mutations
 * itself.
 */

export const CONTINUATION_DEBOUNCE_MS = 800;
export const SILENCE_TIMEOUT_MS = 60_000;

/**
 * Strip markdown decoration before speech synthesis — TTS should say
 * "Done. Invoice sent." not "asterisk asterisk Done asterisk asterisk".
 */
export function stripMarkdownForSpeech(text: string): string {
  return text
    // fenced/inline code
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    // links/images: keep the label
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // bold/italic/strikethrough markers
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    // headings + blockquotes + list bullets at line starts
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    // table/pipe noise
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type ConversationEndReason = 'manual' | 'silence' | 'error';

export interface UseConversationVoice {
  /** Session is live: mic open, utterances auto-submitting. */
  active: boolean;
  /** Live partial transcript of the in-flight utterance (for the composer). */
  partial: string;
  error: string | null;
  isSpeaking: boolean;
  supported: boolean;
  start: () => Promise<void>;
  stop: () => void;
  /** Speak an assistant reply (markdown stripped); barge-in can cut it off. */
  speak: (text: string) => void;
}

export function useConversationVoice(opts: {
  /** Called once per settled utterance with the text to submit. */
  onSubmit: (text: string) => void | Promise<void>;
  onSessionEnd?: (reason: ConversationEndReason) => void;
  continuationDebounceMs?: number;
  silenceTimeoutMs?: number;
}): UseConversationVoice {
  // Latest-callback refs so the composed callbacks stay stable across renders
  // (same convention as useDeepgramDictation).
  const onSubmitRef = useRef(opts.onSubmit);
  const onSessionEndRef = useRef(opts.onSessionEnd);
  onSubmitRef.current = opts.onSubmit;
  onSessionEndRef.current = opts.onSessionEnd;
  const debounceMs = opts.continuationDebounceMs ?? CONTINUATION_DEBOUNCE_MS;
  const silenceMs = opts.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS;

  const [active, setActive] = useState(false);
  const activeRef = useRef(false);

  const pendingRef = useRef('');
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tts = useTTS({ rate: 1.0 });
  const ttsStopRef = useRef(tts.stop);
  ttsStopRef.current = tts.stop;
  const isSpeakingRef = useRef(false);
  isSpeakingRef.current = tts.isSpeaking;

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const submitPending = useCallback(() => {
    debounceTimerRef.current = null;
    const text = pendingRef.current.trim();
    pendingRef.current = '';
    if (text) void onSubmitRef.current(text);
  }, []);

  // Forward-declared so the dictation callbacks (created below, invoked
  // later) can end the session; assigned after `dictation` exists.
  const endSessionRef = useRef<(reason: ConversationEndReason) => void>(() => {});

  const resetSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current !== null) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => {
      silenceTimerRef.current = null;
      endSessionRef.current('silence');
    }, silenceMs);
  }, [silenceMs]);

  const dictation = useDeepgramDictation({
    onPartial: (text) => {
      if (!activeRef.current) return;
      if (!text.trim()) return;
      resetSilenceTimer();
      // Barge-in: the owner talking over the assistant cuts the reply.
      if (isSpeakingRef.current) ttsStopRef.current();
      // Continuation: more speech inside the debounce window holds the
      // pending submission so the next final concatenates instead of
      // double-submitting.
      clearDebounce();
    },
    onUtteranceEnd: (text) => {
      if (!activeRef.current) return;
      resetSilenceTimer();
      clearDebounce();
      pendingRef.current = pendingRef.current ? `${pendingRef.current} ${text}` : text;
      debounceTimerRef.current = setTimeout(submitPending, debounceMs);
    },
  });

  const dictationStopRef = useRef(dictation.stop);
  dictationStopRef.current = dictation.stop;

  const endSession = useCallback(
    (reason: ConversationEndReason) => {
      if (!activeRef.current) return;
      activeRef.current = false;
      setActive(false);
      clearDebounce();
      if (silenceTimerRef.current !== null) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      pendingRef.current = '';
      dictationStopRef.current();
      ttsStopRef.current();
      onSessionEndRef.current?.(reason);
    },
    [clearDebounce],
  );
  endSessionRef.current = endSession;

  const start = useCallback(async () => {
    if (activeRef.current) return;
    pendingRef.current = '';
    activeRef.current = true;
    setActive(true);
    resetSilenceTimer();
    await dictation.start();
  }, [dictation.start, resetSilenceTimer]); // eslint-disable-line react-hooks/exhaustive-deps

  const stop = useCallback(() => endSession('manual'), [endSession]);

  // A dictation transport error (mic denied, WS drop) ends the session so the
  // UI never shows a live conversation with a dead mic.
  useEffect(() => {
    if (active && dictation.error) endSession('error');
  }, [active, dictation.error, endSession]);

  const speak = useCallback(
    (text: string) => {
      const spoken = stripMarkdownForSpeech(text);
      if (spoken) void tts.speak(spoken);
    },
    [tts.speak], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Clear timers on unmount (the dictation/TTS hooks clean up their own
  // mic/WS/speech resources).
  useEffect(
    () => () => {
      if (debounceTimerRef.current !== null) clearTimeout(debounceTimerRef.current);
      if (silenceTimerRef.current !== null) clearTimeout(silenceTimerRef.current);
    },
    [],
  );

  return {
    active,
    partial: dictation.partial,
    error: dictation.error,
    isSpeaking: tts.isSpeaking,
    supported: dictation.supported,
    start,
    stop,
    speak,
  };
}
