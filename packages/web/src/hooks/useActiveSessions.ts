/**
 * P12-003 / X10 — `useActiveSessions`.
 *
 * Supervisor wall data source. Two-part wiring required by the WS
 * gateway's auth model (`authorizeSubscribe` in
 * `packages/api/src/ws/client-gateway.ts` rejects voice subscriptions
 * that omit a `targetId`):
 *
 *   1. Discovery: GET /api/voice/sessions/active returns the list of
 *      live sessions for the tenant. The hook seeds local state from
 *      this and polls it every 10s to catch sessions that arrived
 *      after mount.
 *   2. Per-session subscribe: for each discovered sessionId the hook
 *      sends `{ kind: 'subscribe', channel: 'voice', targetId: id }`
 *      so the gateway forwards `voice.event` frames for that session.
 *
 * Tests should mock this module if they need a non-empty session list
 * to drive a particular UI state (see `ModeSwitchModal.test.tsx` and
 * `CompressedSessionStrip.test.tsx`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useResilientStream, type WsServerFrame } from './useResilientStream';

export type SessionChannel = 'voice_inbound' | 'sms' | 'mms' | 'inapp_voice';

export interface ActiveSessionSummary {
  id: string;
  channel: SessionChannel;
  customerLabel: string;
  /** Confidence of the current draft proposal (0–1), if any. */
  confidence?: number;
  /** Seconds remaining on the auto-approve countdown, if any. */
  countdownSecs?: number;
  startedAt: string;
}

export interface UseActiveSessionsResult {
  sessions: ActiveSessionSummary[];
  /** True while the WS is connecting / waiting for the first frame. */
  isConnecting: boolean;
  /** Count of proposals currently in 'ready_for_review' across all sessions. */
  pendingProposalCount: number;
}

interface ActiveSessionDTO {
  id: string;
  channel: SessionChannel;
  startedAt: string;
}

const TERMINAL_VOICE_EVENTS = new Set(['ended', 'session_terminated']);
const DISCOVERY_POLL_MS = 10_000;

function buildWsUrl(): string {
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/ws`;
}

async function fetchActiveSessions(token: string): Promise<ActiveSessionDTO[]> {
  const res = await fetch('/api/voice/sessions/active', {
    headers: { Authorization: `Bearer ${token}` },
  });
  // Throw on non-2xx so the caller's catch keeps the previous session
  // state instead of treating a transient 401/500/proxy blip as
  // "tenant has zero sessions" and flapping the wall to empty.
  if (!res.ok) throw new Error(`/active responded ${res.status}`);
  const body = (await res.json()) as { sessions?: ActiveSessionDTO[] };
  return Array.isArray(body.sessions) ? body.sessions : [];
}

export function useActiveSessions(): UseActiveSessionsResult {
  const { getToken } = useAuth();
  const [token, setToken] = useState<string>('');
  const [sessions, setSessions] = useState<Map<string, ActiveSessionSummary>>(
    () => new Map()
  );
  const sendRef = useRef<((frame: object) => void) | null>(null);
  const subscribedRef = useRef<Set<string>>(new Set());
  const wsConnectedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const t = await getToken({ template: 'serviceos' });
        if (!cancelled && t) setToken(t);
      } catch {
        // No token — stream stays disabled below.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  const subscribeToSession = useCallback((sessionId: string) => {
    if (subscribedRef.current.has(sessionId)) return;
    if (!wsConnectedRef.current) return;
    sendRef.current?.({
      kind: 'subscribe',
      channel: 'voice',
      targetId: sessionId,
    });
    subscribedRef.current.add(sessionId);
  }, []);

  const unsubscribeFromSession = useCallback((sessionId: string) => {
    if (!subscribedRef.current.has(sessionId)) return;
    if (wsConnectedRef.current) {
      sendRef.current?.({
        kind: 'unsubscribe',
        channel: 'voice',
        targetId: sessionId,
      });
    }
    subscribedRef.current.delete(sessionId);
  }, []);

  const reconcileSessions = useCallback(
    (discovered: ActiveSessionDTO[]) => {
      const discoveredIds = new Set(discovered.map((s) => s.id));
      setSessions((prev) => {
        const next = new Map(prev);
        for (const s of discovered) {
          if (!next.has(s.id)) {
            next.set(s.id, {
              id: s.id,
              channel: s.channel,
              customerLabel: 'Caller',
              startedAt: s.startedAt,
            });
          }
        }
        for (const id of prev.keys()) {
          if (!discoveredIds.has(id)) next.delete(id);
        }
        return next;
      });
      for (const s of discovered) subscribeToSession(s.id);
      for (const id of Array.from(subscribedRef.current)) {
        if (!discoveredIds.has(id)) unsubscribeFromSession(id);
      }
    },
    [subscribeToSession, unsubscribeFromSession]
  );

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const list = await fetchActiveSessions(token);
        if (!cancelled) reconcileSessions(list);
      } catch {
        // Network blip — next tick retries.
      }
    };
    void poll();
    const handle = setInterval(() => void poll(), DISCOVERY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [token, reconcileSessions]);

  const handleFrame = useCallback((frame: WsServerFrame) => {
    if (frame.kind !== 'voice.event') return;
    const { sessionId, event, payload } = frame;
    if (TERMINAL_VOICE_EVENTS.has(event)) {
      unsubscribeFromSession(sessionId);
      setSessions((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
      return;
    }
    setSessions((prev) => {
      const next = new Map(prev);
      const existing = next.get(sessionId);
      const customerLabel =
        (typeof payload?.customerLabel === 'string' && payload.customerLabel) ||
        existing?.customerLabel ||
        'Caller';
      const channel =
        (typeof payload?.channel === 'string' &&
          (payload.channel as SessionChannel)) ||
        existing?.channel ||
        'voice_inbound';
      const confidence =
        typeof payload?.confidence === 'number'
          ? payload.confidence
          : existing?.confidence;
      const countdownSecs =
        typeof payload?.countdownSecs === 'number'
          ? payload.countdownSecs
          : existing?.countdownSecs;
      next.set(sessionId, {
        id: sessionId,
        channel,
        customerLabel,
        confidence,
        countdownSecs,
        startedAt: existing?.startedAt ?? new Date().toISOString(),
      });
      return next;
    });
  }, [unsubscribeFromSession]);

  const knownSessionIds = useMemo(
    () => Array.from(sessions.keys()),
    [sessions]
  );

  const handleOpen = useCallback(() => {
    wsConnectedRef.current = true;
    subscribedRef.current.clear();
    for (const id of knownSessionIds) subscribeToSession(id);
  }, [knownSessionIds, subscribeToSession]);

  const wsUrl = buildWsUrl();
  const { status, send } = useResilientStream({
    enabled: !!token && !!wsUrl,
    url: wsUrl,
    token,
    onFrame: handleFrame,
    onOpen: handleOpen,
  });
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  useEffect(() => {
    if (status !== 'open') {
      wsConnectedRef.current = false;
    }
  }, [status]);

  return {
    sessions: Array.from(sessions.values()),
    isConnecting: status === 'connecting',
    pendingProposalCount: 0,
  };
}
