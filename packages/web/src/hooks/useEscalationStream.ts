import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { fetchWithAuthRetry, isAuthRejectedStatus } from '../lib/streamAuth';

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
    // ordinary reconnect so a wrong/expired token doesn't hammer the API.
    // ARCH-30 — a persistent rejection now also goes through
    // fetchWithAuthRetry's handleAuthFailure() (Clerk sign-out / login
    // redirect), so this is a fallback in case that navigation hasn't
    // completed yet (e.g. latched behind a concurrent 401 elsewhere) rather
    // than the sole recovery path — the previous code retried forever here
    // and never signed the user out.
    const AUTH_RETRY_MS = 60_000;
    const backoff = (attempt: number) => Math.min(1000 * Math.pow(2, attempt), 30_000);

    const subscribe = async (attempt = 0): Promise<void> => {
      if (cancelled) return;
      sseAbortRef.current?.abort();
      const controller = new AbortController();
      sseAbortRef.current = controller;

      try {
        const response = await fetchWithAuthRetry(
          (opts) => getToken({ template: 'serviceos', ...opts }),
          '/api/escalations/events',
          { method: 'GET', headers: { Accept: 'text/event-stream' }, signal: controller.signal },
        );
        if (cancelled) return;

        if (isAuthRejectedStatus(response.status)) {
          reconnectTimer = setTimeout(() => void subscribe(attempt + 1), AUTH_RETRY_MS);
          return;
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
