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

  const eventSourceRef = useRef<EventSource | null>(null);
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

  const subscribeToEvents = useCallback(
    async (id: string) => {
      // EventSource doesn't accept custom headers, so we tunnel the
      // Clerk token via a query string. The server's auth middleware
      // accepts either header- or query-supplied tokens; failing that,
      // the SSE call simply never connects.
      const token = await getToken();
      const qs = token ? `?token=${encodeURIComponent(token)}` : '';
      const es = new EventSource(`/api/voice/sessions/${id}/events${qs}`);
      eventSourceRef.current = es;
      es.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as VoiceSessionEventMessage;
          if (msg.state) setState(msg.state);
          if (msg.type === 'ended') {
            setEnded(true);
            es.close();
          }
          if (msg.type === 'proposal_created' && msg.proposalId) {
            setProposalIds((prev) => (prev.includes(msg.proposalId!) ? prev : [...prev, msg.proposalId!]));
          }
        } catch {
          // ignore malformed payloads
        }
      };
      es.onerror = () => {
        // Browser will auto-retry; on hard close we set ended below.
      };
    },
    [getToken]
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
      void subscribeToEvents(body.sessionId);
    } finally {
      setIsStarting(false);
    }
  }, [api, sessionId, isStarting, playAudio, subscribeToEvents]);

  const send = useCallback(
    async (text: string) => {
      if (!sessionId || ended || !text.trim()) return;
      setIsSending(true);
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
      setEnded(true);
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    }
  }, [api, sessionId]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
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
