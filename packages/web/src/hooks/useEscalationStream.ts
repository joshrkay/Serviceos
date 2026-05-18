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

    const subscribe = async (attempt = 0): Promise<void> => {
      if (cancelled) return;
      sseAbortRef.current?.abort();
      const controller = new AbortController();
      sseAbortRef.current = controller;

      try {
        const token = await getToken();
        const headers: Record<string, string> = { Accept: 'text/event-stream' };
        if (token) headers.Authorization = `Bearer ${token}`;

        const response = await fetch('/api/escalations/events', {
          method: 'GET',
          headers,
          signal: controller.signal,
        });

        if (response.status === 401 || response.status === 403) {
          // Auth failure — don't keep retrying.
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

        // Stream closed cleanly — reconnect with backoff.
        if (!cancelled) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
          reconnectTimer = setTimeout(() => void subscribe(attempt + 1), delay);
        }
      } catch {
        if (cancelled) return;
        const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
        reconnectTimer = setTimeout(() => void subscribe(attempt + 1), delay);
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
