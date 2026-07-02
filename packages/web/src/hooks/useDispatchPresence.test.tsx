/**
 * UC-3 — useDispatchPresence transport tests.
 *
 * WS path: heartbeats ride the shared client-gateway socket (subscribe +
 * presence.update frames, presence reads via dispatch.presence pushes).
 * HTTP fallback: when the WS is not open, the hook degrades to the legacy
 * PUT/DELETE contract at a ≥30s cadence with a matching ttlMs — never the
 * original 5s amplifier.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useDispatchPresence,
  HTTP_FALLBACK_POLL_MS,
  HTTP_FALLBACK_TTL_MS,
} from './useDispatchPresence';
import type { GatewayHandle } from './useActiveSessions';
import type { WsServerFrame } from './useResilientStream';

vi.mock('@clerk/clerk-react', () => ({
  useUser: () => ({
    user: { id: 'test-user', fullName: 'Alex Doe' },
  }),
}));

const apiFetchMock = vi.fn(
  async (..._args: unknown[]) => ({ ok: true, status: 204 }) as Response,
);
vi.mock('../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const gatewayState: { gateway: GatewayHandle } = {
  gateway: { status: 'idle', send: () => {}, onFrame: () => () => {} },
};
vi.mock('./useActiveSessions', () => ({
  useActiveSessions: () => ({
    sessions: [],
    isConnecting: false,
    pendingProposalCount: 0,
    gateway: gatewayState.gateway,
  }),
}));

function makeOpenGateway() {
  const sent: Array<Record<string, unknown>> = [];
  const listeners = new Set<(frame: WsServerFrame) => void>();
  const gateway: GatewayHandle = {
    status: 'open',
    send: (frame: object) => {
      sent.push(frame as Record<string, unknown>);
    },
    onFrame: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const receive = (frame: WsServerFrame) => {
    for (const l of Array.from(listeners)) l(frame);
  };
  return { gateway, sent, receive, listeners };
}

const DATE = new Date(2026, 4, 20); // 2026-05-20 local
const DATE_PARAM = '2026-05-20';

describe('useDispatchPresence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiFetchMock.mockClear();
    gatewayState.gateway = { status: 'idle', send: () => {}, onFrame: () => () => {} };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('WS transport (gateway open)', () => {
    it('subscribes to the dispatch channel and heartbeats presence.update every 5s', () => {
      const { gateway, sent } = makeOpenGateway();
      gatewayState.gateway = gateway;

      const { unmount } = renderHook(() => useDispatchPresence(DATE, null));

      expect(sent).toContainEqual({
        kind: 'subscribe',
        channel: 'dispatch',
        targetId: DATE_PARAM,
      });
      const beats = () => sent.filter((f) => f.kind === 'presence.update');
      expect(beats()).toHaveLength(1);
      expect(beats()[0]).toMatchObject({
        date: DATE_PARAM,
        mode: 'viewing',
        appointmentId: null,
        displayName: 'Alex Doe',
      });

      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(beats()).toHaveLength(2);
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(beats()).toHaveLength(4);

      // No HTTP traffic on the WS path.
      expect(apiFetchMock).not.toHaveBeenCalled();
      unmount();
    });

    it('sends a dragging heartbeat immediately when a drag starts', () => {
      const { gateway, sent } = makeOpenGateway();
      gatewayState.gateway = gateway;

      const { rerender } = renderHook(
        ({ drag }: { drag: string | null }) => useDispatchPresence(DATE, drag),
        { initialProps: { drag: null as string | null } },
      );
      rerender({ drag: 'appt-1' });

      const beats = sent.filter((f) => f.kind === 'presence.update');
      expect(beats[beats.length - 1]).toMatchObject({
        mode: 'dragging',
        appointmentId: 'appt-1',
      });
    });

    it('exposes peers from dispatch.presence pushes for the current date only', () => {
      const { gateway, receive } = makeOpenGateway();
      gatewayState.gateway = gateway;

      const { result } = renderHook(() => useDispatchPresence(DATE, null));
      expect(result.current.transport).toBe('ws');
      expect(result.current.peers).toEqual([]);

      const entries = [
        { userId: 'u2', displayName: 'Sam', appointmentId: 'appt-9', mode: 'dragging' as const },
      ];
      act(() => {
        receive({ kind: 'dispatch.presence', channel: 'dispatch', date: '2026-05-21', entries });
      });
      expect(result.current.peers).toEqual([]); // other date ignored

      act(() => {
        receive({ kind: 'dispatch.presence', channel: 'dispatch', date: DATE_PARAM, entries });
      });
      expect(result.current.peers).toEqual(entries);
    });

    it('clears presence and unsubscribes on unmount', () => {
      const { gateway, sent, listeners } = makeOpenGateway();
      gatewayState.gateway = gateway;

      const { unmount } = renderHook(() => useDispatchPresence(DATE, null));
      unmount();

      expect(sent).toContainEqual({ kind: 'presence.clear', date: DATE_PARAM });
      expect(sent).toContainEqual({
        kind: 'unsubscribe',
        channel: 'dispatch',
        targetId: DATE_PARAM,
      });
      expect(listeners.size).toBe(0);
    });
  });

  describe('HTTP fallback (gateway not open)', () => {
    it('PUTs immediately, then polls at ≥30s — never the legacy 5s cadence', () => {
      gatewayState.gateway = { status: 'closed', send: () => {}, onFrame: () => () => {} };

      const { result, unmount } = renderHook(() => useDispatchPresence(DATE, null));
      expect(result.current.transport).toBe('http');

      const puts = () =>
        apiFetchMock.mock.calls.filter(
          (call) => (call[1] as RequestInit | undefined)?.method === 'PUT',
        );
      expect(puts()).toHaveLength(1);

      // Legacy cadence would have beaten several times by 29s — fallback must not.
      act(() => {
        vi.advanceTimersByTime(HTTP_FALLBACK_POLL_MS - 1_000);
      });
      expect(puts()).toHaveLength(1);

      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(puts()).toHaveLength(2);
      expect(HTTP_FALLBACK_POLL_MS).toBeGreaterThanOrEqual(30_000);
      unmount();
    });

    it('sends a ttlMs that outlives the poll interval (old servers ignore it safely)', () => {
      gatewayState.gateway = { status: 'closed', send: () => {}, onFrame: () => () => {} };

      const { unmount } = renderHook(() => useDispatchPresence(DATE, null));
      const [url, init] = apiFetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/dispatch/presence');
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ date: DATE_PARAM, mode: 'viewing', ttlMs: HTTP_FALLBACK_TTL_MS });
      expect(HTTP_FALLBACK_TTL_MS).toBeGreaterThan(HTTP_FALLBACK_POLL_MS);
      unmount();
    });

    it('DELETEs presence on unmount (legacy contract preserved)', () => {
      gatewayState.gateway = { status: 'closed', send: () => {}, onFrame: () => () => {} };

      const { unmount } = renderHook(() => useDispatchPresence(DATE, null));
      unmount();
      const del = apiFetchMock.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(del?.[0]).toBe(`/api/dispatch/presence?date=${DATE_PARAM}`);
    });

    it('reports empty peers on the fallback path', () => {
      gatewayState.gateway = { status: 'closed', send: () => {}, onFrame: () => () => {} };
      const { result, unmount } = renderHook(() => useDispatchPresence(DATE, null));
      expect(result.current.peers).toEqual([]);
      unmount();
    });
  });

  it('switches from HTTP fallback to WS when the gateway opens', () => {
    gatewayState.gateway = { status: 'closed', send: () => {}, onFrame: () => () => {} };
    const { result, rerender, unmount } = renderHook(() => useDispatchPresence(DATE, null));
    expect(result.current.transport).toBe('http');

    const { gateway, sent } = makeOpenGateway();
    gatewayState.gateway = gateway;
    rerender();

    expect(result.current.transport).toBe('ws');
    expect(sent.some((f) => f.kind === 'subscribe')).toBe(true);
    // The fallback loop cleaned up with its DELETE.
    const del = apiFetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(del).toBeTruthy();
    unmount();
  });
});
