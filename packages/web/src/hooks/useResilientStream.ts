/**
 * useResilientStream — small WS client matching the API client gateway
 * protocol. Falls back to a no-op when WebSocket is unavailable or the
 * runtime flag is off; existing SSE consumers stay untouched until a
 * future ramp flips this on.
 *
 * "Resilient" = auto-reconnect on socket `close`/`error` with capped
 * exponential backoff (1s → 2s → 4s → ... → 30s), reset on every
 * successful open. Intentional unmount (deps change or hook teardown)
 * does NOT trigger a reconnect — the cleanup flag is checked inside
 * the close handler so the previous socket's terminal events can't
 * fight the next attempt.
 *
 * Server frames mirror the shapes in
 * `packages/api/src/ws/protocol.ts`. We keep the type definitions inline
 * to avoid a new bundle dependency on the API package.
 */
import { useEffect, useRef, useState } from 'react';

export type WsServerFrame =
  | { kind: 'hello'; serverTimeMs: number; heartbeatIntervalMs: number; seq?: number }
  | { kind: 'heartbeat'; serverTimeMs: number; seq?: number }
  | { kind: 'subscribed'; channel: string; seq?: number }
  | { kind: 'error'; code: string; message: string; seq?: number }
  | {
      kind: 'assistant.token';
      channel: 'assistant';
      delta: string;
      correlationId?: string;
      degraded?: boolean;
      seq?: number;
    }
  | {
      kind: 'assistant.done';
      channel: 'assistant';
      finalText: string;
      proposalId?: string;
      correlationId?: string;
      degraded?: boolean;
      fallbackStage?: string;
      seq?: number;
    }
  | {
      kind: 'voice.event';
      channel: 'voice';
      sessionId: string;
      event: string;
      state?: string;
      payload?: Record<string, unknown>;
      seq?: number;
    };

export interface UseResilientStreamOptions {
  enabled: boolean;
  url: string;
  token: string;
  onFrame?: (frame: WsServerFrame) => void;
  onOpen?: () => void;
  onClose?: (reason: string) => void;
}

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export function useResilientStream(opts: UseResilientStreamOptions): {
  status: StreamStatus;
  send: (frame: object) => void;
} {
  const [status, setStatus] = useState<StreamStatus>('idle');
  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const [reconnectTrigger, setReconnectTrigger] = useState(0);

  useEffect(() => {
    if (!opts.enabled) {
      setStatus('idle');
      return;
    }
    if (typeof WebSocket === 'undefined') {
      setStatus('error');
      return;
    }
    const url = new URL(opts.url);
    if (opts.token) url.searchParams.set('token', opts.token);
    setStatus('connecting');

    const ws = new WebSocket(url.toString());
    wsRef.current = ws;
    let unmounted = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleReconnect = () => {
      if (unmounted) return;
      attemptRef.current += 1;
      const delay = Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_BASE_MS * 2 ** (attemptRef.current - 1),
      );
      reconnectTimer = setTimeout(() => {
        if (!unmounted) setReconnectTrigger((n) => n + 1);
      }, delay);
    };

    ws.onopen = () => {
      attemptRef.current = 0;
      setStatus('open');
      opts.onOpen?.();
    };
    ws.onmessage = (ev) => {
      try {
        const frame = JSON.parse(ev.data) as WsServerFrame;
        opts.onFrame?.(frame);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = (ev) => {
      if (unmounted) return;
      setStatus('closed');
      opts.onClose?.(ev.reason || 'closed');
      scheduleReconnect();
    };
    ws.onerror = () => {
      if (unmounted) return;
      setStatus('error');
      scheduleReconnect();
    };

    return () => {
      unmounted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws.close(1000, 'unmount');
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.enabled, opts.url, opts.token, reconnectTrigger]);

  return {
    status,
    send: (frame) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    },
  };
}
