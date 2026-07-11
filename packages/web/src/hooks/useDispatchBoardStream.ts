import { useEffect, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { fetchWithAuthRetry } from '../lib/streamAuth';

export interface DispatchBoardStreamEvent {
  type: 'board_updated' | 'presence_updated';
  date: string;
  boardRevision?: string;
}

export interface DispatchBoardStreamOptions {
  /**
   * UC-3 — when presence rides the WS gateway (useDispatchPresence transport
   * === 'ws'), presence state arrives as dispatch.presence pushes, so a
   * presence_updated SSE event doesn't need a full board refetch here.
   * board_updated always refetches.
   */
  presenceViaWs?: boolean;
}

export function useDispatchBoardStream(
  dateParam: string,
  currentRevision: string | undefined,
  onStale: () => void,
  options: DispatchBoardStreamOptions = {},
): void {
  const { getToken } = useAuth();
  const lastRevisionRef = useRef(currentRevision);
  const sseFailedAtRef = useRef<number | null>(null);
  const sseAbortRef = useRef<AbortController | null>(null);
  // Ref-backed so toggling the flag never tears down the SSE connection.
  const presenceViaWsRef = useRef(options.presenceViaWs ?? false);
  presenceViaWsRef.current = options.presenceViaWs ?? false;

  useEffect(() => {
    lastRevisionRef.current = currentRevision;
  }, [currentRevision]);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const handleEvent = (evt: DispatchBoardStreamEvent) => {
      if (evt.date !== dateParam) return;
      if (evt.type === 'board_updated' && evt.boardRevision) {
        if (lastRevisionRef.current && evt.boardRevision !== lastRevisionRef.current) {
          onStale();
        }
        lastRevisionRef.current = evt.boardRevision;
      }
      if (evt.type === 'presence_updated' && !presenceViaWsRef.current) {
        onStale();
      }
    };

    const subscribe = async (attempt = 0): Promise<void> => {
      if (cancelled) return;
      sseAbortRef.current?.abort();
      const controller = new AbortController();
      sseAbortRef.current = controller;

      try {
        // ARCH-30 — shared 401/403 handling (retry once with a
        // force-refreshed token, then handleAuthFailure() on the request
        // layer's terminal exit) instead of the old bare `return`, which
        // left the board silently dead until the operator navigated away
        // and back. A still-rejected response falls through to the
        // `!response.ok` branch below, which throws into the catch block's
        // existing exponential-backoff reconnect.
        const response = await fetchWithAuthRetry(
          (opts) => getToken({ template: 'serviceos', ...opts }),
          `/api/dispatch/board/events?date=${encodeURIComponent(dateParam)}`,
          { method: 'GET', headers: { Accept: 'text/event-stream' }, signal: controller.signal },
        );

        if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`);

        sseFailedAtRef.current = null;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done || cancelled) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of block.split('\n')) {
              if (!line.startsWith('data:')) continue;
              try {
                handleEvent(JSON.parse(line.slice(5).trim()) as DispatchBoardStreamEvent);
              } catch {
                // ignore
              }
            }
          }
        }
        if (!cancelled) {
          const delay = Math.min(1000 * 2 ** attempt, 30_000);
          reconnectTimer = setTimeout(() => void subscribe(attempt + 1), delay);
        }
      } catch {
        if (cancelled) return;
        if (sseFailedAtRef.current === null) sseFailedAtRef.current = Date.now();
        const delay = Math.min(1000 * 2 ** attempt, 30_000);
        reconnectTimer = setTimeout(() => void subscribe(attempt + 1), delay);
      }
    };

    void subscribe();

    pollTimer = setInterval(() => {
      if (sseFailedAtRef.current && Date.now() - sseFailedAtRef.current >= 60_000) {
        onStale();
      }
    }, 15_000);

    return () => {
      cancelled = true;
      sseAbortRef.current?.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [dateParam, getToken, onStale]);
}
