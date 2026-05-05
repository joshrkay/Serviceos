/**
 * useResilientStream — small WS client matching the API client gateway
 * protocol. Falls back to a no-op when WebSocket is unavailable or the
 * runtime flag is off; existing SSE consumers stay untouched until a
 * future ramp flips this on.
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

export function useResilientStream(opts: UseResilientStreamOptions): {
  status: StreamStatus;
  send: (frame: object) => void;
} {
  const [status, setStatus] = useState<StreamStatus>('idle');
  const wsRef = useRef<WebSocket | null>(null);

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

    ws.onopen = () => {
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
      setStatus('closed');
      opts.onClose?.(ev.reason || 'closed');
    };
    ws.onerror = () => {
      setStatus('error');
    };

    return () => {
      try {
        ws.close(1000, 'unmount');
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.enabled, opts.url, opts.token]);

  return {
    status,
    send: (frame) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    },
  };
}
