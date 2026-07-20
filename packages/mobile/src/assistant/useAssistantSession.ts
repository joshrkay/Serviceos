/**
 * U13 — stateful "talk to the agent" session hook over the existing in-app
 * voice-session API (packages/api/src/routes/voice-sessions.ts).
 *
 * The hook owns the conversation state machine; all I/O is delegated to an
 * INJECTED transport (so tests drive a fake stream with no network) and an
 * INJECTED audio player (so tests need no real playback). The screen wires the
 * real `expo/fetch` transport + `expo-audio` player.
 *
 * Contract highlights:
 *   - start → greeting turn → text/voice input → async SSE pushes → ended.
 *   - The synchronous `POST /:id/input` already returns the full turn, so a
 *     dropped SSE stream degrades gracefully: async pushes are lost but the
 *     conversation keeps working over sync round-trips.
 *   - Sessions END. The server idle-reaps after ~30 min; an ended/reaped
 *     session answers 410 (still-present, ended) or 404 (reaped/removed). Both
 *     mean "start a new one" — the hook NEVER retries into them.
 *   - 401 is retried ONCE with a force-refreshed token on the event stream
 *     (POST/DELETE already refresh-retry inside apiFetch); a persistent 401 or
 *     a 403 (a persona without `ai:run`) surfaces gracefully, no reconnect loop.
 *   - AppState background→foreground reconnects the stream; if the session was
 *     reaped while backgrounded (>30 min) the reconnect takes the 404 → expired
 *     path, again without a retry loop.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { VoiceSessionMessage } from './sseParser';

/** Terminal-403 error: the caller's persona lacks `ai:run`. */
export class AssistantForbiddenError extends Error {
  constructor(message = 'You do not have access to the assistant.') {
    super(message);
    this.name = 'AssistantForbiddenError';
  }
}

/** Terminal-401 error: re-authentication is required (apiFetch retry exhausted). */
export class AssistantAuthError extends Error {
  constructor(message = 'Your session expired. Please sign in again.') {
    super(message);
    this.name = 'AssistantAuthError';
  }
}

function isForbidden(e: unknown): boolean {
  return e instanceof AssistantForbiddenError || (e as Error)?.name === 'AssistantForbiddenError';
}
function isAuth(e: unknown): boolean {
  return (
    e instanceof AssistantAuthError ||
    (e as Error)?.name === 'AssistantAuthError' ||
    (e as Error)?.name === 'UnauthorizedError'
  );
}

/** Result of `POST /api/voice/sessions`. */
export interface StartResult {
  sessionId: string;
  state: string;
  greetingText?: string;
  greetingAudio?: string; // base64 mp3
}

/** Result of `POST /api/voice/sessions/:id/input` (status carries 410/404). */
export interface TurnResult {
  status: number;
  state?: string;
  ttsText?: string;
  ttsAudio?: string; // base64 mp3
  proposalIds?: string[];
  ended?: boolean;
}

/** Result of `POST /api/voice/transcribe` — 501 becomes `notConfigured`. */
export type TranscribeResult = { transcript: string } | { notConfigured: true };

/** Outcome of opening / holding the SSE event stream. */
export interface EventStreamResult {
  /** HTTP status when connected (200 open, else the rejection status). 0 = never connected. */
  status: number;
  /** True when a connected (200) stream broke mid-flight rather than closing cleanly. */
  dropped?: boolean;
}

/**
 * Transport surface the hook depends on. The real implementation lives in
 * expoFetchTransport.ts (`expo/fetch` streaming + apiFetch); tests inject a fake.
 */
export interface AssistantTransport {
  start(input: { conversationId?: string }): Promise<StartResult>;
  sendInput(sessionId: string, text: string): Promise<TurnResult>;
  /** Per-turn STT: multipart POST of the recorded clip URI to /api/voice/transcribe. */
  transcribe(fileUri: string): Promise<TranscribeResult>;
  end(sessionId: string): Promise<void>;
  /**
   * Open the SSE stream, invoking `onMessage` for each parsed frame. Resolves
   * when the stream closes (cleanly or dropped) or the connection is rejected.
   * `forceRefresh` asks the transport to mint a fresh token for the 401 retry.
   */
  openEvents(
    sessionId: string,
    handlers: { onMessage: (m: VoiceSessionMessage) => void },
    signal: AbortSignal,
    opts?: { forceRefresh?: boolean },
  ): Promise<EventStreamResult>;
}

/** Injected TTS player — base64 in, playback out. Isolated so hook tests skip audio. */
export interface AssistantAudioPlayer {
  play(base64: string): void | Promise<void>;
}

export interface AssistantSessionDeps {
  transport: AssistantTransport;
  player: AssistantAudioPlayer;
}

/**
 * Session lifecycle status.
 *   idle     — no session
 *   starting — start() in flight
 *   active   — session live, ready for input
 *   sending  — a turn round-trip is in flight
 *   ended    — the agent closed the session normally
 *   expired  — 410/404: reaped/gone; the user must start a new one
 *   error    — start / auth / forbidden / network failure
 */
export type AssistantStatus =
  | 'idle'
  | 'starting'
  | 'active'
  | 'sending'
  | 'ended'
  | 'expired'
  | 'error';

export interface AssistantError {
  kind: 'auth' | 'forbidden' | 'network' | 'transcribe';
  message: string;
}

export interface AssistantTurn {
  id: string;
  role: 'assistant' | 'user';
  text: string;
}

export interface UseAssistantSession {
  sessionId: string | null;
  status: AssistantStatus;
  state: string | null;
  turns: readonly AssistantTurn[];
  proposalIds: readonly string[];
  error: AssistantError | null;
  /** True once per-turn STT returned 501 — the screen falls back to text input. */
  sttUnavailable: boolean;
  start: () => Promise<void>;
  sendText: (text: string) => Promise<void>;
  /** Transcribe a recorded clip (file URI) and, on success, send it as a turn. */
  sendAudio: (fileUri: string) => Promise<void>;
  end: () => Promise<void>;
}

export function useAssistantSession(deps: AssistantSessionDeps): UseAssistantSession {
  const { transport, player } = deps;

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<AssistantStatus>('idle');
  const [state, setState] = useState<string | null>(null);
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [proposalIds, setProposalIds] = useState<string[]>([]);
  const [error, setError] = useState<AssistantError | null>(null);
  const [sttUnavailable, setSttUnavailable] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const turnSeq = useRef(0);
  // Refs mirror state for the AppState listener (registered once), which would
  // otherwise capture a stale closure.
  const sessionIdRef = useRef<string | null>(null);
  const statusRef = useRef<AssistantStatus>('idle');
  sessionIdRef.current = sessionId;
  statusRef.current = status;

  const nextTurnId = () => `t${turnSeq.current++}`;
  const pushTurn = (role: 'assistant' | 'user', text: string) => {
    if (!text) return;
    setTurns((prev) => [...prev, { id: nextTurnId(), role, text }]);
  };
  const addProposalId = (id: string) =>
    setProposalIds((prev) => (prev.includes(id) ? prev : [...prev, id]));

  const stopStream = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // ---- SSE subscription (transport-agnostic; parsing lives in the transport) ----
  const handleMessage = useCallback((m: VoiceSessionMessage) => {
    if (!mountedRef.current) return;
    if (m.state) setState(m.state);
    if (m.type === 'proposal_created' && typeof m.proposalId === 'string') {
      addProposalId(m.proposalId);
    }
    if (m.type === 'ended') {
      setStatus('ended');
      stopStream();
    }
  }, [stopStream]);

  const subscribe = useCallback(
    async (id: string, forceRefresh = false): Promise<void> => {
      stopStream();
      const controller = new AbortController();
      abortRef.current = controller;

      let result: EventStreamResult;
      try {
        result = await transport.openEvents(id, { onMessage: handleMessage }, controller.signal, {
          forceRefresh,
        });
      } catch {
        // Never connected (network error establishing the stream). Degrade to
        // sync input round-trips rather than looping on reconnect.
        return;
      }
      // A deliberate abort (unmount / end / resubscribe) must not be acted on.
      if (controller.signal.aborted || !mountedRef.current) return;

      const { status: sseStatus, dropped } = result;
      if (sseStatus === 200) {
        // Clean close (the 'ended' frame already updated state) or a mid-flight
        // drop — either way the sync path stays available; no reconnect loop.
        return;
      }
      if (sseStatus === 401 && !forceRefresh) {
        void subscribe(id, true); // one refresh-retry
        return;
      }
      if (sseStatus === 401) {
        setError({ kind: 'auth', message: new AssistantAuthError().message });
        setStatus('error');
        return;
      }
      if (sseStatus === 403) {
        setError({ kind: 'forbidden', message: new AssistantForbiddenError().message });
        setStatus('error');
        return;
      }
      if (sseStatus === 404) {
        // Reaped / gone while we were connected or on reconnect — start anew.
        setStatus('expired');
        return;
      }
      // Any other rejection: degrade to sync, no loop.
    },
    [transport, handleMessage, stopStream],
  );

  // ---- start ----
  const start = useCallback(async () => {
    if (status === 'starting' || status === 'active' || status === 'sending') return;
    setStatus('starting');
    setError(null);
    setSttUnavailable(false);
    setTurns([]);
    setProposalIds([]);
    try {
      const res = await transport.start({});
      if (!mountedRef.current) return;
      setSessionId(res.sessionId);
      setState(res.state);
      setStatus('active');
      if (res.greetingText) pushTurn('assistant', res.greetingText);
      if (res.greetingAudio) void player.play(res.greetingAudio);
      void subscribe(res.sessionId);
    } catch (e) {
      if (!mountedRef.current) return;
      if (isForbidden(e)) {
        setError({ kind: 'forbidden', message: (e as Error).message });
      } else if (isAuth(e)) {
        setError({ kind: 'auth', message: (e as Error).message });
      } else {
        setError({ kind: 'network', message: 'Could not start the assistant. Please retry.' });
      }
      setStatus('error');
    }
  }, [transport, player, subscribe, status]);

  // ---- sendText ----
  const sendText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      const id = sessionIdRef.current;
      if (!id || !trimmed) return;
      if (status !== 'active') return; // not while sending / ended / expired / error
      setStatus('sending');
      setError(null);
      pushTurn('user', trimmed);

      let res: TurnResult;
      try {
        res = await transport.sendInput(id, trimmed);
      } catch (e) {
        if (!mountedRef.current) return;
        if (isForbidden(e)) {
          setError({ kind: 'forbidden', message: (e as Error).message });
          setStatus('error');
        } else if (isAuth(e)) {
          setError({ kind: 'auth', message: (e as Error).message });
          setStatus('error');
        } else {
          // Transient — keep the session usable so the user can retry.
          setError({ kind: 'network', message: 'That did not go through. Please retry.' });
          setStatus('active');
        }
        return;
      }
      if (!mountedRef.current) return;

      if (res.status === 410 || res.status === 404) {
        // Ended / reaped — no retry, prompt to start a new session.
        setStatus('expired');
        stopStream();
        return;
      }

      if (res.state) setState(res.state);
      if (res.ttsText) pushTurn('assistant', res.ttsText);
      if (res.ttsAudio) void player.play(res.ttsAudio);
      if (Array.isArray(res.proposalIds)) {
        for (const pid of res.proposalIds) addProposalId(pid);
      }
      if (res.ended) {
        setStatus('ended');
        stopStream();
      } else {
        setStatus('active');
      }
    },
    [transport, player, stopStream, status],
  );

  // ---- sendAudio (per-turn STT → sync input) ----
  const sendAudio = useCallback(
    async (fileUri: string) => {
      if (!sessionIdRef.current || status !== 'active' || !fileUri) return;
      setError(null);
      let res: TranscribeResult;
      try {
        res = await transport.transcribe(fileUri);
      } catch (e) {
        if (!mountedRef.current) return;
        if (isForbidden(e)) {
          setError({ kind: 'forbidden', message: (e as Error).message });
          setStatus('error');
        } else if (isAuth(e)) {
          setError({ kind: 'auth', message: (e as Error).message });
          setStatus('error');
        } else {
          setError({ kind: 'transcribe', message: "Couldn't transcribe that. Try typing instead." });
        }
        return;
      }
      if (!mountedRef.current) return;
      if ('notConfigured' in res) {
        // Server has no STT provider (501) — fall back to text input.
        setSttUnavailable(true);
        return;
      }
      await sendText(res.transcript);
    },
    [transport, sendText, status],
  );

  // ---- end ----
  const end = useCallback(async () => {
    const id = sessionIdRef.current;
    stopStream();
    if (id) {
      try {
        await transport.end(id);
      } catch {
        // best-effort teardown
      }
    }
    if (!mountedRef.current) return;
    setSessionId(null);
    setState(null);
    setStatus('idle');
    setTurns([]);
    setProposalIds([]);
    setError(null);
    setSttUnavailable(false);
  }, [transport, stopStream]);

  // ---- AppState reconnect (background → foreground) ----
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: string) => {
      if (next !== 'active') return;
      const id = sessionIdRef.current;
      // Only reconnect a session that was live; a reaped session's reconnect
      // returns 404 → the subscribe() 404 branch flips us to 'expired'.
      if (id && (statusRef.current === 'active' || statusRef.current === 'sending')) {
        void subscribe(id);
      }
    });
    return () => sub.remove();
  }, [subscribe]);

  // ---- unmount: abort stream, block further setState ----
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  return {
    sessionId,
    status,
    state,
    turns,
    proposalIds,
    error,
    sttUnavailable,
    start,
    sendText,
    sendAudio,
    end,
  };
}
