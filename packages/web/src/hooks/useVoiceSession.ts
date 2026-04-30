/**
 * useVoiceSession — P8-009
 *
 * React hook for in-app voice sessions over HTTP + SSE.
 */

import { useCallback, useRef } from 'react';
import { apiFetch } from '../utils/api-fetch';

export interface VoiceSessionEvent {
  state: string;
  context?: Record<string, unknown>;
  error?: string;
}

export function useVoiceSession() {
  const eventSourceRef = useRef<EventSource | null>(null);

  /** POST /api/voice/sessions → { sessionId } */
  const createSession = useCallback(
    async (conversationId?: string): Promise<string> => {
      const res = await apiFetch('/api/voice/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Failed to create voice session: ${res.status} ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as { sessionId: string };
      return data.sessionId;
    },
    [],
  );

  /** POST /api/voice/sessions/:id/input → { state, ttsAudio?, proposalId? } */
  const sendInput = useCallback(
    async (
      sessionId: string,
      text: string,
    ): Promise<{ state: string; ttsAudio?: string; proposalId?: string }> => {
      const res = await apiFetch(`/api/voice/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(
          `Failed to send voice input: ${res.status} ${errText.slice(0, 200)}`,
        );
      }
      return res.json() as Promise<{ state: string; ttsAudio?: string; proposalId?: string }>;
    },
    [],
  );

  /**
   * Open an EventSource to GET /api/voice/sessions/:id/events.
   * Each SSE message is parsed and passed to `onEvent`.
   * Returns a cleanup function that closes the EventSource.
   */
  const subscribeEvents = useCallback(
    (sessionId: string, onEvent: (event: VoiceSessionEvent) => void): (() => void) => {
      // Close any existing EventSource before opening a new one.
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const es = new EventSource(`/api/voice/sessions/${sessionId}/events`);
      eventSourceRef.current = es;

      es.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data) as VoiceSessionEvent;
          onEvent(parsed);
        } catch {
          // Malformed frame — ignore.
        }
      };

      es.onerror = () => {
        onEvent({ state: 'error', error: 'SSE connection error' });
        es.close();
        eventSourceRef.current = null;
      };

      return () => {
        es.close();
        eventSourceRef.current = null;
      };
    },
    [],
  );

  /** DELETE /api/voice/sessions/:id → 204 */
  const deleteSession = useCallback(async (sessionId: string): Promise<void> => {
    await apiFetch(`/api/voice/sessions/${sessionId}`, { method: 'DELETE' });
  }, []);

  return { createSession, sendInput, subscribeEvents, deleteSession };
}
