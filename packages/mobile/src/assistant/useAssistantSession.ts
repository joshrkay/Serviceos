import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { ApiFetch } from '../lib/apiFetch';
import { decodeError } from '../lib/appError';
import { createSseParser, parseSseJson } from './sseParser';

/**
 * useAssistantSession (U13) — stateful "talk to the agent" client over the
 * existing in-app voice-session API:
 *
 *   POST   /api/voice/sessions              start (greeting text + TTS)
 *   POST   /api/voice/sessions/:id/input    one turn (sync — the degrade path)
 *   GET    /api/voice/sessions/:id/events   SSE pushes (async proposals etc.)
 *   DELETE /api/voice/sessions/:id          end
 *
 * Transport: injected `streamFetch` (expo/fetch on device — supports response
 * streaming; `react-native-sse` is the named plan-B and only this dep swaps)
 * with the Clerk token in the Authorization header — the server's `?token=`
 * query fallback was deliberately removed (leaks to logs); never reintroduce
 * it. A broken stream loses only async pushes: the synchronous input POST
 * already returns the full turn, so the conversation keeps working.
 *
 * Sessions END: the server idle-reaps after ~30 min and an ended/reaped
 * session answers 410 GONE (or 404 once swept). Both resolve to the
 * "conversation ended — start a new one" state; nothing retries into a 410.
 */

export type AssistantPhase = 'idle' | 'starting' | 'active' | 'ended' | 'unavailable' | 'error';

export interface AssistantTurn {
  id: number;
  role: 'owner' | 'agent';
  text: string;
}

export interface AssistantSessionDeps {
  /** Interactive client (Clerk auth + 401 retry baked in) for JSON calls. */
  api: ApiFetch;
  /** Streaming-capable fetch for the SSE reader. */
  streamFetch: (url: string, init: RequestInit) => Promise<Response>;
  getToken: (opts?: { forceRefresh?: boolean }) => Promise<string | null>;
  baseUrl: string;
  /** Native TTS playback (base64 mp3 → cache file → expo-audio player). */
  playTts?: (b64: string) => Promise<void>;
}

export interface UseAssistantSessionResult {
  phase: AssistantPhase;
  fsmState: string | null;
  turns: readonly AssistantTurn[];
  proposalIds: readonly string[];
  /** Transient per-turn error (phase stays 'active'). */
  error: string | null;
  /** True once /api/voice/transcribe answered 501 — text input only. */
  sttUnavailable: boolean;
  isSending: boolean;
  start: () => Promise<void>;
  sendText: (text: string) => Promise<void>;
  /** Per-turn STT: transcribe the clip, then send the transcript as a turn. */
  sendClip: (clip: { fileUri: string; contentType: string }) => Promise<void>;
  end: () => Promise<void>;
}

export const SESSION_ENDED_COPY = 'This conversation ended — start a new one.';
export const STT_UNAVAILABLE_COPY =
  'Voice input is not available right now — type your message instead.';

interface SessionEventMessage {
  type?: string;
  state?: string;
  proposalId?: string;
}

/** Statuses that mean "this session is over" — never retried. */
function isSessionGoneStatus(status: number): boolean {
  return status === 410 || status === 404;
}

export function useAssistantSession(deps: AssistantSessionDeps): UseAssistantSessionResult {
  const { api, streamFetch, getToken, baseUrl, playTts } = deps;
  const [phase, setPhase] = useState<AssistantPhase>('idle');
  const [fsmState, setFsmState] = useState<string | null>(null);
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [proposalIds, setProposalIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sttUnavailable, setSttUnavailable] = useState(false);
  const [isSending, setIsSending] = useState(false);

  const sessionIdRef = useRef<string | null>(null);
  const phaseRef = useRef<AssistantPhase>('idle');
  phaseRef.current = phase;
  const sseAbortRef = useRef<AbortController | null>(null);
  const turnIdRef = useRef(0);

  const pushTurn = useCallback((role: 'owner' | 'agent', text: string) => {
    turnIdRef.current += 1;
    const turn: AssistantTurn = { id: turnIdRef.current, role, text };
    setTurns((prev) => [...prev, turn]);
  }, []);

  const speak = useCallback(
    (b64: string | undefined) => {
      if (!b64 || !playTts) return;
      void playTts(b64).catch(() => {
        // Playback is best-effort — the text turn is already rendered.
      });
    },
    [playTts],
  );

  const closeStream = useCallback(() => {
    sseAbortRef.current?.abort();
    sseAbortRef.current = null;
  }, []);

  const sessionEnded = useCallback(() => {
    closeStream();
    sessionIdRef.current = null;
    setPhase('ended');
  }, [closeStream]);

  const handleEventData = useCallback(
    (data: string) => {
      const msg = parseSseJson<SessionEventMessage>(data);
      if (!msg) return;
      if (msg.state) setFsmState(msg.state);
      if (msg.type === 'proposal_created' && msg.proposalId) {
        const id = msg.proposalId;
        setProposalIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
      }
      if (msg.type === 'ended') sessionEnded();
    },
    [sessionEnded],
  );

  const subscribe = useCallback(
    async (id: string) => {
      closeStream();
      const controller = new AbortController();
      sseAbortRef.current = controller;

      const open = async (forceRefresh: boolean): Promise<Response | null> => {
        let token: string | null = null;
        try {
          token = await getToken({ forceRefresh });
        } catch {
          return null;
        }
        if (!token) return null;
        try {
          return await streamFetch(`${baseUrl}/api/voice/sessions/${id}/events`, {
            method: 'GET',
            headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
        } catch {
          return null; // aborted or transport failure — sync path still works
        }
      };

      let response = await open(false);
      if (response && response.status === 401) response = await open(true);
      if (!response) return;
      if (isSessionGoneStatus(response.status)) {
        // Reconnecting into an ended/reaped session (e.g. >30 min in the
        // background) — take the ended path, never a retry loop.
        if (sessionIdRef.current === id) sessionEnded();
        return;
      }
      if (!response.ok || !response.body) return; // degrade: sync round-trips only

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const data of parser.push(decoder.decode(value, { stream: true }))) {
            handleEventData(data);
          }
        }
      } catch {
        // aborted or stream dropped — degrade to the sync round-trip
      }
    },
    [baseUrl, closeStream, getToken, handleEventData, sessionEnded, streamFetch],
  );

  const start = useCallback(async () => {
    if (phaseRef.current === 'starting' || phaseRef.current === 'active') return;
    setPhase('starting');
    setError(null);
    setTurns([]);
    setProposalIds([]);
    setFsmState(null);
    try {
      const res = await api('/api/voice/sessions', { method: 'POST', body: JSON.stringify({}) });
      if (res.status === 403) {
        // Persona without ai:run (technician) — the entry is nav-gated, but
        // surface it gracefully rather than as a generic error.
        setPhase('unavailable');
        return;
      }
      if (!res.ok) throw new Error((await decodeError(res)).message);
      const body = (await res.json()) as {
        sessionId: string;
        state: string;
        greetingText?: string;
        greetingAudio?: string;
      };
      sessionIdRef.current = body.sessionId;
      setFsmState(body.state);
      if (body.greetingText) pushTurn('agent', body.greetingText);
      speak(body.greetingAudio);
      setPhase('active');
      void subscribe(body.sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the assistant.');
      setPhase('error');
    }
  }, [api, pushTurn, speak, subscribe]);

  const sendText = useCallback(
    async (text: string) => {
      const id = sessionIdRef.current;
      const trimmed = text.trim();
      if (!id || !trimmed || phaseRef.current !== 'active') return;
      setIsSending(true);
      setError(null);
      pushTurn('owner', trimmed);
      try {
        const res = await api(`/api/voice/sessions/${id}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: trimmed }),
        });
        if (isSessionGoneStatus(res.status)) {
          sessionEnded();
          return;
        }
        if (!res.ok) {
          // The turn failed but the session lives — surface and stay active.
          setError((await decodeError(res)).message);
          return;
        }
        const body = (await res.json()) as {
          state: string;
          ttsText?: string;
          ttsAudio?: string;
          proposalIds?: string[];
          ended?: boolean;
        };
        setFsmState(body.state);
        if (body.ttsText) pushTurn('agent', body.ttsText);
        speak(body.ttsAudio);
        if (Array.isArray(body.proposalIds) && body.proposalIds.length > 0) {
          setProposalIds((prev) => {
            const next = [...prev];
            for (const pid of body.proposalIds!) if (!next.includes(pid)) next.push(pid);
            return next;
          });
        }
        if (body.ended) sessionEnded();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Sending failed. Please retry.');
      } finally {
        setIsSending(false);
      }
    },
    [api, pushTurn, sessionEnded, speak],
  );

  const sendClip = useCallback(
    async (clip: { fileUri: string; contentType: string }) => {
      if (phaseRef.current !== 'active') return;
      setIsSending(true);
      setError(null);
      try {
        // RN fetch uploads a local file via the {uri,type,name} FormData part.
        const form = new FormData();
        form.append('audio', {
          uri: clip.fileUri,
          type: clip.contentType,
          name: 'turn.m4a',
        } as unknown as Blob);
        const res = await api('/api/voice/transcribe', { method: 'POST', body: form });
        if (res.status === 501) {
          // STT not configured on this API (no AI_PROVIDER_API_KEY) — fall
          // back to text input for the rest of the session.
          setSttUnavailable(true);
          setError(STT_UNAVAILABLE_COPY);
          return;
        }
        if (!res.ok) {
          setError((await decodeError(res)).message);
          return;
        }
        const body = (await res.json()) as { transcript?: string };
        const transcript = (body.transcript ?? '').trim();
        if (!transcript) {
          setError('I could not hear that — try again or type it.');
          return;
        }
        await sendText(transcript);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Voice input failed. Please retry.');
      } finally {
        setIsSending(false);
      }
    },
    [api, sendText],
  );

  const end = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    try {
      await api(`/api/voice/sessions/${id}`, { method: 'DELETE' });
    } catch {
      // ending is best-effort — the server idle-reaps abandoned sessions
    } finally {
      sessionEnded();
    }
  }, [api, sessionEnded]);

  // Foreground resume: reconnect the event stream; if the session was reaped
  // while backgrounded (>30 min idle), subscribe() lands on 410/404 and takes
  // the ended path.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const id = sessionIdRef.current;
      if (state === 'active' && id && phaseRef.current === 'active') {
        void subscribe(id);
      }
    });
    return () => sub.remove();
  }, [subscribe]);

  // Abort the stream on unmount.
  useEffect(() => closeStream, [closeStream]);

  return {
    phase,
    fsmState,
    turns,
    proposalIds,
    error,
    sttUnavailable,
    isSending,
    start,
    sendText,
    sendClip,
    end,
  };
}
