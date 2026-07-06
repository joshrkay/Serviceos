import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';

export interface EscalationPanelData {
  header?: { title: string; callerName: string; callerPhone: string };
  customer?: { name: string; phone: string; tags?: string[] };
  lastInteraction?: string | null;
  intent?: { summary: string; entities?: Array<{ key: string; value: string }> };
  reason?: { code: string; humanReadable: string };
  transcriptSnapshot?: Array<{ role: 'caller' | 'ai'; text: string; ts: number }>;
}

export interface EscalationEvent {
  type: 'escalation_started';
  escalationId: string;
  reason: string;
  dispatcherUserId: string;
  ts: number;
  panel?: EscalationPanelData;
}

export interface UseEscalationStream {
  activeEscalations: EscalationEvent[];
  dismissEscalation: (escalationId: string) => void;
}

/**
 * Subscribes to the user's escalation event stream via SSE.
 * Mirrors useVoiceSession SSE pattern. Maintains a queue of active
 * escalations so concurrent transfers to the same dispatcher render
 * stacked panels.
 */
export function useEscalationStream(): UseEscalationStream {
  const { getToken } = useAuth();
  const [activeEscalations, setActiveEscalations] = useState<EscalationEvent[]>([]);
  const sseAbortRef = useRef<AbortController | null>(null);

  const dismissEscalation = useCallback((escalationId: string) => {
    setActiveEscalations((prev) => prev.filter((e) => e.escalationId !== escalationId));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    // Backoff floor for a persistent auth rejection — slower than the
    // ordinary reconnect so a wrong/expired token doesn't hammer the API,
    // but NOT permanent (the previous code gave up for the page lifetime on
    // a single 401, silently killing escalations for the dispatcher).
    const AUTH_RETRY_MS = 60_000;
    const backoff = (attempt: number) => Math.min(1000 * Math.pow(2, attempt), 30_000);

    const subscribe = async (attempt = 0): Promise<void> => {
      if (cancelled) return;
      sseAbortRef.current?.abort();
      const controller = new AbortController();
      sseAbortRef.current = controller;

      const openStream = async (skipCache: boolean): Promise<Response | null> => {
        const token = await getToken({ template: 'serviceos', skipCache });
        // Never send an unauthenticated request — a null token means Clerk is
        // mid-refresh or signing out; the caller retries after a short delay.
        if (!token) return null;
        return fetch('/api/escalations/events', {
          method: 'GET',
          headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
      };

      try {
        let response = await openStream(false);
        if (cancelled) return;
        if (!response) {
          // No token yet — retry shortly rather than firing without auth.
          reconnectTimer = setTimeout(() => void subscribe(attempt + 1), backoff(attempt));
          return;
        }

        if (response.status === 401 || response.status === 403) {
          // Token rejected — retry once with a force-refreshed token before
          // backing off, mirroring the fetch clients' 401 handling.
          response = await openStream(true);
          if (cancelled) return;
          if (!response || response.status === 401 || response.status === 403) {
            reconnectTimer = setTimeout(() => void subscribe(attempt + 1), AUTH_RETRY_MS);
            return;
          }
        }
        if (!response.ok || !response.body) {
          throw new Error(`SSE failed: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done || cancelled) break;
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf('\n\n')) !== -1) {
              const eventBlock = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              for (const line of eventBlock.split('\n')) {
                if (line.startsWith('data:')) {
                  try {
                    const evt = JSON.parse(line.slice(5).trim()) as EscalationEvent;
                    if (evt.type === 'escalation_started') {
                      setActiveEscalations((prev) => [...prev, evt]);
                    }
                  } catch {
                    // ignore malformed
                  }
                }
              }
            }
          }
        } catch {
          // aborted or stream broken — fall through to reconnect
        }

        // Stream closed after a SUCCESSFUL connection — reset the backoff so
        // routine server-side stream recycling reconnects fast, instead of
        // creeping toward the 30s cap over a long-lived session.
        if (!cancelled) {
          reconnectTimer = setTimeout(() => void subscribe(0), backoff(0));
        }
      } catch {
        if (cancelled) return;
        reconnectTimer = setTimeout(() => void subscribe(attempt + 1), backoff(attempt));
      }
    };

    void subscribe();
    return () => {
      cancelled = true;
      sseAbortRef.current?.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [getToken]);

  return { activeEscalations, dismissEscalation };
}
