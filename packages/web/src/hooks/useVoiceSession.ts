/**
 * useVoiceSession — minimal text-only client for the in-app voice session
 * API (P8-009).
 *
 * Wraps:
 *   POST   /api/voice/sessions         (start)
 *   POST   /api/voice/sessions/:id/input
 *   GET    /api/voice/sessions/:id/events  (SSE)
 *   DELETE /api/voice/sessions/:id     (end)
 *
 * Real microphone capture / streaming STT is *not* in scope here — that
 * arrives in P8-012. The current hook is text-in / TTS-out so the UI
 * can prove the round trip end-to-end.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiClient } from '../lib/apiClient';
import { useAuth } from '@clerk/clerk-react';

const PENDO_AGENT_ID = 'QqL8kYRqTigq-GYw5ga0ibEjhKs';

interface VoiceSessionEventMessage {
  type: string;
  state?: string;
  event?: string;
  reason?: string;
  proposalId?: string;
}

export interface UseVoiceSession {
  sessionId: string | null;
  state: string | null;
  isStarting: boolean;
  isSending: boolean;
  ended: boolean;
  proposalIds: string[];
  /** Last TTS text the agent spoke (already played as audio if available). */
  lastTtsText: string | null;
  start: () => Promise<void>;
  send: (text: string) => Promise<void>;
  end: () => Promise<void>;
}

/** Decode a base64 mp3 string into a Blob the <audio> element can play. */
function base64ToBlob(b64: string, mime = 'audio/mpeg'): Blob | null {
  try {
    const binary = atob(b64);
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    return new Blob([buf], { type: mime });
  } catch {
    return null;
  }
}

export function useVoiceSession(): UseVoiceSession {
  const api = useApiClient();
  const { getToken } = useAuth();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [ended, setEnded] = useState(false);
  const [proposalIds, setProposalIds] = useState<string[]>([]);
  const [lastTtsText, setLastTtsText] = useState<string | null>(null);

  // We use a fetch-based SSE reader (not native EventSource) so we can send
  // the Clerk bearer token in the Authorization header. The previous
  // `?token=...` query-string approach leaked tokens into URL logs and
  // referer headers — the server no longer accepts that fallback.
  const sseAbortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const playAudio = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob);
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }
    const el = audioRef.current;
    el.src = url;
    el.onended = () => URL.revokeObjectURL(url);
    void el.play().catch(() => {
      // Autoplay may be blocked until the user interacts; that's fine —
      // the text is still rendered in the UI.
      URL.revokeObjectURL(url);
    });
  }, []);

  const handleSseLine = useCallback((line: string) => {
    if (!line.startsWith('data:')) return; // skip comments/heartbeats
    const data = line.slice(5).trim();
    if (!data) return;
    try {
      const msg = JSON.parse(data) as VoiceSessionEventMessage;
      if (msg.state) setState(msg.state);
      if (msg.type === 'ended') {
        setEnded(true);
        sseAbortRef.current?.abort();
        sseAbortRef.current = null;
      }
      if (msg.type === 'proposal_created' && msg.proposalId) {
        setProposalIds((prev) => (prev.includes(msg.proposalId!) ? prev : [...prev, msg.proposalId!]));
      }
    } catch {
      // ignore malformed payloads
    }
  }, []);

  const subscribeToEvents = useCallback(
    async (id: string) => {
      // Cancel any prior subscription before starting a new one.
      sseAbortRef.current?.abort();
      const controller = new AbortController();
      sseAbortRef.current = controller;

      const token = await getToken();
      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      if (token) headers.Authorization = `Bearer ${token}`;

      let response: Response;
      try {
        response = await fetch(`/api/voice/sessions/${id}/events`, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
      } catch {
        return; // aborted or network error — leave state to caller
      }

      if (response.status === 401 || response.status === 403) {
        // Surface auth failures explicitly instead of silently retrying.
        setEnded(true);
        return;
      }
      if (!response.ok || !response.body) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE event boundary is a blank line (\n\n). Process every
          // complete event in the buffer; keep the trailing partial.
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const eventBlock = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of eventBlock.split('\n')) {
              handleSseLine(line);
            }
          }
        }
      } catch {
        // aborted or stream broken — caller drives reconnect via start()
      }
    },
    [getToken, handleSseLine]
  );

  const start = useCallback(async () => {
    if (sessionId || isStarting) return;
    setIsStarting(true);
    try {
      const res = await api('/api/voice/sessions', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`start failed: ${res.status}`);
      const body = (await res.json()) as {
        sessionId: string;
        state: string;
        greetingText?: string;
        greetingAudio?: string;
      };
      setSessionId(body.sessionId);
      setState(body.state);
      setEnded(false);
      setProposalIds([]);
      if (body.greetingText) setLastTtsText(body.greetingText);
      if (body.greetingAudio) {
        const blob = base64ToBlob(body.greetingAudio);
        if (blob) playAudio(blob);
      }
      if (body.greetingText && typeof pendo !== 'undefined') {
        pendo.trackAgent('agent_response', {
          agentId: PENDO_AGENT_ID,
          conversationId: body.sessionId,
          messageId: `agent_response_${Date.now()}`,
          content: body.greetingText,
        });
      }
      void subscribeToEvents(body.sessionId);
    } finally {
      setIsStarting(false);
    }
  }, [api, sessionId, isStarting, playAudio, subscribeToEvents]);

  const send = useCallback(
    async (text: string) => {
      if (!sessionId || ended || !text.trim()) return;
      setIsSending(true);
      const promptMessageId = crypto.randomUUID();
      if (typeof pendo !== 'undefined') {
        pendo.trackAgent('prompt', {
          agentId: PENDO_AGENT_ID,
          conversationId: sessionId,
          messageId: promptMessageId,
          content: text,
        });
      }
      try {
        const res = await api(`/api/voice/sessions/${sessionId}/input`, {
          method: 'POST',
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error(`send failed: ${res.status}`);
        const body = (await res.json()) as {
          state: string;
          ttsText?: string;
          ttsAudio?: string;
          proposalIds?: string[];
          ended?: boolean;
        };
        setState(body.state);
        if (body.ttsText) setLastTtsText(body.ttsText);
        if (body.ttsAudio) {
          const blob = base64ToBlob(body.ttsAudio);
          if (blob) playAudio(blob);
        }
        if (Array.isArray(body.proposalIds)) setProposalIds(body.proposalIds);
        if (body.ended) setEnded(true);
        if (body.ttsText && typeof pendo !== 'undefined') {
          pendo.trackAgent('agent_response', {
            agentId: PENDO_AGENT_ID,
            conversationId: sessionId,
            messageId: `agent_response_${Date.now()}`,
            content: body.ttsText,
          });
        }
      } finally {
        setIsSending(false);
      }
    },
    [api, sessionId, ended, playAudio]
  );

  const end = useCallback(async () => {
    if (!sessionId) return;
    try {
      await api(`/api/voice/sessions/${sessionId}`, { method: 'DELETE' });
    } finally {
      // Reset the full session-scoped state so the user can start a new
      // session in the same component lifecycle. start() short-circuits
      // when sessionId is set, so leaving it populated would lock the
      // panel into the ended state until a remount.
      sseAbortRef.current?.abort();
      sseAbortRef.current = null;
      setSessionId(null);
      setState(null);
      setEnded(true);
      setProposalIds([]);
      setLastTtsText(null);
    }
  }, [api, sessionId]);

  useEffect(() => {
    return () => {
      sseAbortRef.current?.abort();
      sseAbortRef.current = null;
    };
  }, []);

  return {
    sessionId,
    state,
    isStarting,
    isSending,
    ended,
    proposalIds,
    lastTtsText,
    start,
    send,
    end,
  };
}
