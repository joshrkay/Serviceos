/**
 * UC-3 — dispatch presence over the client gateway WebSocket.
 *
 * Drives a ClientGatewayConnection with a fake `ws` EventEmitter (the harness
 * from client-gateway.test.ts) and a fake DispatchPresenceGatewayDeps seam:
 * heartbeat/clear frames land in the deps, dispatch subscriptions push
 * presence state (initially and on presence_updated), and teardown clears
 * presence + bus subscriptions.
 */
import { EventEmitter } from 'events';
import { describe, it, expect, vi } from 'vitest';
import { ClientGatewayConnection } from '../../src/ws/client-gateway';
import type {
  AuthResult,
  DispatchPresenceGatewayDeps,
  DispatchPresenceEntry,
} from '../../src/ws/client-gateway';
import type { ConnectionLease } from '../../src/ws/connection-registry';

const AUTH: AuthResult = { tenantId: 'tenant-1', userId: 'user-1', tenantTier: 'standard' };
const DATE = '2026-05-20';

class FakeWs extends EventEmitter {
  sent: Array<Record<string, unknown>> = [];
  closes: Array<{ code?: number; reason?: string }> = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    this.closes.push({ code, reason });
  }
}

function makeLease(): ConnectionLease {
  return { release: vi.fn(async () => {}), refresh: vi.fn(async () => {}) } as ConnectionLease;
}

function makePresenceDeps(entries: DispatchPresenceEntry[] = []) {
  const boardListeners: Array<(evt: { type: string; date: string }) => void> = [];
  const unsub = vi.fn();
  const deps: DispatchPresenceGatewayDeps = {
    update: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    list: vi.fn(async () => entries),
    subscribeBoard: vi.fn((_tenantId, _date, listener) => {
      boardListeners.push(listener);
      return unsub;
    }),
  };
  return { deps, boardListeners, unsub };
}

const cfg = {
  heartbeatIntervalMs: 10_000_000,
  idleTimeoutMs: 10_000_000,
  queueMaxMsgs: 200,
  queueMaxBytes: 4 * 1024 * 1024,
};

const tick = () => new Promise((r) => setImmediate(r));

function makeConn(ws: FakeWs, dispatchPresence?: DispatchPresenceGatewayDeps) {
  return new ClientGatewayConnection(ws as never, AUTH, makeLease(), { ...cfg, dispatchPresence });
}

function emitFrame(ws: FakeWs, frame: Record<string, unknown>) {
  ws.emit('message', JSON.stringify(frame));
}

describe('ClientGatewayConnection — dispatch presence (UC-3)', () => {
  it('routes a presence.update heartbeat into the deps with the connection auth', async () => {
    const ws = new FakeWs();
    const { deps } = makePresenceDeps();
    makeConn(ws, deps);
    emitFrame(ws, {
      kind: 'presence.update',
      date: DATE,
      mode: 'dragging',
      appointmentId: 'appt-1',
      displayName: 'Alex',
    });
    await tick();
    expect(deps.update).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      userId: 'user-1',
      displayName: 'Alex',
      date: DATE,
      mode: 'dragging',
      appointmentId: 'appt-1',
    });
    expect(ws.sent.some((f) => f.kind === 'error')).toBe(false);
  });

  it('defaults appointmentId to null and displayName to the userId', async () => {
    const ws = new FakeWs();
    const { deps } = makePresenceDeps();
    makeConn(ws, deps);
    emitFrame(ws, { kind: 'presence.update', date: DATE, mode: 'viewing' });
    await tick();
    expect(deps.update).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentId: null, displayName: 'user-1' }),
    );
  });

  it('rejects presence.update with PRESENCE_UNSUPPORTED when the seam is not wired', async () => {
    const ws = new FakeWs();
    makeConn(ws); // no dispatchPresence deps
    emitFrame(ws, { kind: 'presence.update', date: DATE, mode: 'viewing' });
    await tick();
    expect(ws.sent.some((f) => f.kind === 'error' && f.code === 'PRESENCE_UNSUPPORTED')).toBe(true);
  });

  it('rejects a malformed presence date at the schema layer', async () => {
    const ws = new FakeWs();
    const { deps } = makePresenceDeps();
    makeConn(ws, deps);
    emitFrame(ws, { kind: 'presence.update', date: 'not-a-date', mode: 'viewing' });
    await tick();
    expect(ws.sent.some((f) => f.kind === 'error' && f.code === 'PROTOCOL_ERROR')).toBe(true);
    expect(deps.update).not.toHaveBeenCalled();
  });

  it('subscribe(dispatch, date) pushes the current presence state immediately', async () => {
    const ws = new FakeWs();
    const entries = [
      { userId: 'u2', displayName: 'Sam', appointmentId: 'appt-9', mode: 'dragging' as const },
    ];
    const { deps } = makePresenceDeps(entries);
    const conn = makeConn(ws, deps);
    emitFrame(ws, { kind: 'subscribe', channel: 'dispatch', targetId: DATE });
    await tick();
    expect(conn.isSubscribed('dispatch', DATE)).toBe(true);
    expect(deps.subscribeBoard).toHaveBeenCalledWith('tenant-1', DATE, expect.any(Function));
    const push = ws.sent.find((f) => f.kind === 'dispatch.presence');
    expect(push).toMatchObject({ channel: 'dispatch', date: DATE, entries });
  });

  it('pushes fresh presence state when the board bus fires presence_updated', async () => {
    const ws = new FakeWs();
    const { deps, boardListeners } = makePresenceDeps([]);
    makeConn(ws, deps);
    emitFrame(ws, { kind: 'subscribe', channel: 'dispatch', targetId: DATE });
    await tick();
    ws.sent.length = 0;

    boardListeners[0]({ type: 'presence_updated', date: DATE });
    await tick();
    expect(ws.sent.filter((f) => f.kind === 'dispatch.presence')).toHaveLength(1);

    // board_updated is NOT a presence push trigger (that path stays on SSE).
    boardListeners[0]({ type: 'board_updated', date: DATE });
    await tick();
    expect(ws.sent.filter((f) => f.kind === 'dispatch.presence')).toHaveLength(1);
  });

  it('refuses dispatch subscriptions without a YYYY-MM-DD target or without the seam', async () => {
    const ws = new FakeWs();
    const { deps } = makePresenceDeps();
    makeConn(ws, deps);
    emitFrame(ws, { kind: 'subscribe', channel: 'dispatch' });
    await tick();
    emitFrame(ws, { kind: 'subscribe', channel: 'dispatch', targetId: 'sess-9' });
    await tick();
    expect(ws.sent.filter((f) => f.kind === 'error' && f.code === 'SUBSCRIBE_FORBIDDEN')).toHaveLength(2);

    const bare = new FakeWs();
    makeConn(bare); // seam not wired
    emitFrame(bare, { kind: 'subscribe', channel: 'dispatch', targetId: DATE });
    await tick();
    expect(bare.sent.some((f) => f.kind === 'error' && f.code === 'SUBSCRIBE_FORBIDDEN')).toBe(true);
  });

  it('unsubscribe tears down the per-date board subscription', async () => {
    const ws = new FakeWs();
    const { deps, unsub } = makePresenceDeps();
    makeConn(ws, deps);
    emitFrame(ws, { kind: 'subscribe', channel: 'dispatch', targetId: DATE });
    await tick();
    emitFrame(ws, { kind: 'unsubscribe', channel: 'dispatch', targetId: DATE });
    await tick();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('close clears heartbeated presence and unsubscribes from the bus (tab-close parity)', async () => {
    const ws = new FakeWs();
    const { deps, unsub } = makePresenceDeps();
    const conn = makeConn(ws, deps);
    emitFrame(ws, { kind: 'presence.update', date: DATE, mode: 'viewing', displayName: 'Alex' });
    emitFrame(ws, { kind: 'subscribe', channel: 'dispatch', targetId: DATE });
    await tick();

    conn.terminate('test');
    await tick();
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(deps.clear).toHaveBeenCalledWith({ tenantId: 'tenant-1', userId: 'user-1', date: DATE });
  });

  it('presence.clear stops the close-time auto-clear for that date', async () => {
    const ws = new FakeWs();
    const { deps } = makePresenceDeps();
    const conn = makeConn(ws, deps);
    emitFrame(ws, { kind: 'presence.update', date: DATE, mode: 'viewing' });
    emitFrame(ws, { kind: 'presence.clear', date: DATE });
    await tick();
    expect(deps.clear).toHaveBeenCalledTimes(1);

    conn.terminate('test');
    await tick();
    expect(deps.clear).toHaveBeenCalledTimes(1); // no second clear on close
  });
});
