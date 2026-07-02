/**
 * Dispatch-board presence (UC-3).
 *
 * Primary transport: the ALREADY-OPEN client-gateway WebSocket (shared via
 * `useActiveSessions().gateway`). Heartbeats are `presence.update` frames
 * every 5s — cheap socket writes, no HTTP request and no RLS transaction —
 * and presence READS arrive as `dispatch.presence` pushes on the subscribed
 * `dispatch:{date}` channel, exposed as `peers`.
 *
 * Fallback transport: when the WS is not open (gateway disabled, connecting,
 * or down) the hook degrades to the legacy HTTP PUT — but at a ≥30s cadence
 * with a matching longer `ttlMs`, instead of the original 5s amplifier.
 * `peers` stays empty in fallback mode; consumers keep using the presence
 * snapshot embedded in the board payload.
 */
import { useEffect, useRef, useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { apiFetch } from '../utils/api-fetch';
import { useActiveSessions } from './useActiveSessions';

export interface DispatchPresencePeer {
  userId: string;
  displayName: string;
  appointmentId: string | null;
  mode: 'viewing' | 'dragging';
}

export interface UseDispatchPresenceResult {
  /** Live presence for the board date (WS transport only; [] on HTTP fallback). */
  peers: DispatchPresencePeer[];
  /** Which transport is currently carrying the heartbeat. */
  transport: 'ws' | 'http';
}

/** WS heartbeat — frames on an open socket are cheap; matches the store's 15s lease. */
const WS_HEARTBEAT_MS = 5_000;
/** HTTP fallback poll — each PUT is an RLS transaction, so ≥30s. */
export const HTTP_FALLBACK_POLL_MS = 30_000;
/** Lease sent with fallback PUTs — must outlive the poll interval. */
export const HTTP_FALLBACK_TTL_MS = 75_000;

function toDateParam(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function useDispatchPresence(
  selectedDate: Date,
  dragAppointmentId: string | null,
): UseDispatchPresenceResult {
  const { user } = useUser();
  const { gateway } = useActiveSessions();
  const wsOpen = gateway.status === 'open';
  const dateParam = toDateParam(selectedDate);
  const [peers, setPeers] = useState<DispatchPresencePeer[]>([]);

  const dateRef = useRef(dateParam);
  dateRef.current = dateParam;
  const dragRef = useRef(dragAppointmentId);
  dragRef.current = dragAppointmentId;

  const displayName =
    user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? 'Dispatcher';
  const displayNameRef = useRef(displayName);
  displayNameRef.current = displayName;

  // WS: subscription + presence reads for the board date.
  useEffect(() => {
    if (!wsOpen) return;
    gateway.send({ kind: 'subscribe', channel: 'dispatch', targetId: dateParam });
    const offFrames = gateway.onFrame((frame) => {
      if (frame.kind !== 'dispatch.presence') return;
      if (frame.date !== dateRef.current) return;
      setPeers(frame.entries);
    });
    return () => {
      offFrames();
      gateway.send({ kind: 'presence.clear', date: dateParam });
      gateway.send({ kind: 'unsubscribe', channel: 'dispatch', targetId: dateParam });
      setPeers([]);
    };
  }, [wsOpen, dateParam, gateway]);

  // WS: heartbeat — immediately on mount/drag change, then every 5s.
  useEffect(() => {
    if (!wsOpen) return;
    const beat = () => {
      gateway.send({
        kind: 'presence.update',
        date: dateRef.current,
        mode: dragRef.current ? 'dragging' : 'viewing',
        appointmentId: dragRef.current,
        displayName: displayNameRef.current,
      });
    };
    beat();
    const interval = setInterval(beat, WS_HEARTBEAT_MS);
    return () => clearInterval(interval);
  }, [wsOpen, dateParam, dragAppointmentId, gateway]);

  // HTTP fallback: legacy PUT/DELETE contract, lengthened to a ≥30s poll with
  // a ttlMs that outlives it. Runs only while the WS is not open.
  useEffect(() => {
    if (wsOpen) return;
    let cancelled = false;

    const send = async (mode: 'viewing' | 'dragging', appointmentId: string | null) => {
      await apiFetch('/api/dispatch/presence', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: dateRef.current,
          mode,
          appointmentId,
          displayName: displayNameRef.current,
          ttlMs: HTTP_FALLBACK_TTL_MS,
        }),
      });
    };

    const tick = () => {
      if (cancelled) return;
      void send(dragAppointmentId ? 'dragging' : 'viewing', dragAppointmentId).catch(() => {});
    };

    tick();
    const interval = setInterval(tick, HTTP_FALLBACK_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
      void apiFetch(`/api/dispatch/presence?date=${encodeURIComponent(dateRef.current)}`, {
        method: 'DELETE',
      }).catch(() => {});
    };
  }, [wsOpen, dateParam, dragAppointmentId, user]);

  return { peers, transport: wsOpen ? 'ws' : 'http' };
}
