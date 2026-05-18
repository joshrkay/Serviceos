/**
 * P12-003 / X10 — `useActiveSessions`.
 *
 * Supervisor wall data source. Opens a WS to the client gateway
 * (`/api/ws`), subscribes to the `voice` channel, and aggregates the
 * `voice.event` frames into the live session list rendered by
 * `CompressedSessionStrip` and read by `ModeSwitchModal`.
 *
 * Tests should mock this module if they need a non-empty session list
 * to drive a particular UI state (see `ModeSwitchModal.test.tsx` and
 * `CompressedSessionStrip.test.tsx`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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

// Voice events that signal the session is over and should be dropped
// from the wall. Mirrors `VoiceSessionEvent` in the API
// (`packages/api/src/ai/agents/customer-calling/voice-session-store.ts`):
// `ended` (idle/normal termination) and `session_terminated` (VQ-003
// canonical cause). The `payload.cause === 'hangup'` case is covered by
// `session_terminated`.
const TERMINAL_VOICE_EVENTS = new Set(['ended', 'session_terminated']);

function buildWsUrl(): string {
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/ws`;
}

export function useActiveSessions(): UseActiveSessionsResult {
  const { getToken } = useAuth();
  const [token, setToken] = useState<string>('');
  const [sessions, setSessions] = useState<Map<string, ActiveSessionSummary>>(
    () => new Map()
  );
  const sendRef = useRef<((frame: object) => void) | null>(null);

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

  const handleFrame = useCallback((frame: WsServerFrame) => {
    if (frame.kind !== 'voice.event') return;
    const { sessionId, event, payload } = frame;
    if (TERMINAL_VOICE_EVENTS.has(event)) {
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
  }, []);

  const handleOpen = useCallback(() => {
    sendRef.current?.({ kind: 'subscribe', channel: 'voice' });
  }, []);

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

  return {
    sessions: Array.from(sessions.values()),
    isConnecting: status === 'connecting',
    pendingProposalCount: 0,
  };
}
