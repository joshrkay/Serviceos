import { useEffect, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';

export interface DispatchBoardStreamEvent {
  type: 'board_updated' | 'presence_updated';
  date: string;
  boardRevision?: string;
}

export function useDispatchBoardStream(
  dateParam: string,
  currentRevision: string | undefined,
  onStale: () => void,
): void {
  const { getToken } = useAuth();
  const lastRevisionRef = useRef(currentRevision);
  const sseFailedAtRef = useRef<number | null>(null);
  const sseAbortRef = useRef<AbortController | null>(null);

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
      if (evt.type === 'presence_updated') {
        onStale();
      }
    };

    const subscribe = async (attempt = 0): Promise<void> => {
      if (cancelled) return;
      sseAbortRef.current?.abort();
      const controller = new AbortController();
      sseAbortRef.current = controller;

      try {
        const token = await getToken();
        const headers: Record<string, string> = { Accept: 'text/event-stream' };
        if (token) headers.Authorization = `Bearer ${token}`;

        const response = await fetch(
          `/api/dispatch/board/events?date=${encodeURIComponent(dateParam)}`,
          { method: 'GET', headers, signal: controller.signal },
        );

        if (response.status === 401 || response.status === 403) return;
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
