/**
 * Unit tests for the client WebSocket gateway.
 *
 * Two seams are exercised without a real socket:
 *   1. ClientGatewayConnection driven by a fake `ws` EventEmitter — hello frame,
 *      subscription authz, idle-timeout termination, registry slot release.
 *   2. attachClientGateway's upgrade handler with a fake socket — the 401 / 429
 *      / 503 rejection paths and path matching.
 */
import http from 'http';
import { EventEmitter } from 'events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ClientGatewayConnection,
  attachClientGateway,
  CLIENT_GATEWAY_PATH,
} from '../../src/ws/client-gateway';
import { ReconnectGuard } from '../../src/ws/reconnect-guard';
import type { ConnectionRegistry, ConnectionLease } from '../../src/ws/connection-registry';
import type { AuthResult } from '../../src/ws/client-gateway';

const AUTH: AuthResult = { tenantId: 'tenant-1', userId: 'user-1', tenantTier: 'standard' };

class FakeWs extends EventEmitter {
  sent: any[] = [];
  closes: Array<{ code?: number; reason?: string }> = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    this.closes.push({ code, reason });
  }
}

// U3b — the registry API is now async + lease-based: acquire() returns a
// ConnectionLease (release/refresh) or null when at the cap.
function makeLease() {
  const raw = {
    release: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  };
  return { lease: raw as unknown as ConnectionLease, raw };
}

function makeRegistry(acquire = true) {
  const leases: Array<{ release: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> }> = [];
  const registry = {
    acquire: vi.fn(async () => {
      if (!acquire) return null;
      const l = { release: vi.fn(async () => {}), refresh: vi.fn(async () => {}) };
      leases.push(l);
      return l;
    }),
    count: vi.fn(async () => 0),
  } as unknown as ConnectionRegistry;
  return { registry, leases };
}

const cfg = {
  heartbeatIntervalMs: 10_000_000,
  idleTimeoutMs: 10_000_000,
  queueMaxMsgs: 200,
  queueMaxBytes: 4 * 1024 * 1024,
};

const tick = () => new Promise((r) => setImmediate(r));

function makeConn(ws: FakeWs, lease: ConnectionLease, auth: AuthResult = AUTH, cfgOverride = {}) {
  return new ClientGatewayConnection(ws as never, auth, lease, { ...cfg, ...cfgOverride });
}

function emitFrame(ws: FakeWs, frame: Record<string, unknown>) {
  ws.emit('message', JSON.stringify(frame));
}

describe('ClientGatewayConnection', () => {
  it('sends a hello frame on construction', async () => {
    const ws = new FakeWs();
    makeConn(ws, makeLease().lease);
    await tick();
    expect(ws.sent.some((f) => f.kind === 'hello')).toBe(true);
  });

  it('authorizes an assistant subscription to the authenticated user', async () => {
    const ws = new FakeWs();
    const conn = makeConn(ws, makeLease().lease);
    emitFrame(ws, { kind: 'subscribe', channel: 'assistant', targetId: 'user-1' });
    await tick();
    expect(ws.sent.some((f) => f.kind === 'subscribed' && f.channel === 'assistant')).toBe(true);
    expect(conn.isSubscribed('assistant', 'user-1')).toBe(true);
    // exact-match policy: untargeted does not match a targeted subscription
    expect(conn.isSubscribed('assistant')).toBe(false);
  });

  it('refuses an assistant subscription without a targetId', async () => {
    const ws = new FakeWs();
    makeConn(ws, makeLease().lease);
    emitFrame(ws, { kind: 'subscribe', channel: 'assistant' });
    await tick();
    expect(ws.sent.some((f) => f.kind === 'error' && f.code === 'SUBSCRIBE_FORBIDDEN')).toBe(true);
  });

  it('refuses an assistant subscription targeting another user', async () => {
    const ws = new FakeWs();
    const conn = makeConn(ws, makeLease().lease);
    emitFrame(ws, { kind: 'subscribe', channel: 'assistant', targetId: 'someone-else' });
    await tick();
    expect(ws.sent.some((f) => f.kind === 'error' && f.code === 'SUBSCRIBE_FORBIDDEN')).toBe(true);
    expect(conn.isSubscribed('assistant', 'someone-else')).toBe(false);
  });

  it('refuses a voice subscription without a session id but allows one with it', async () => {
    const ws = new FakeWs();
    const conn = makeConn(ws, makeLease().lease);
    emitFrame(ws, { kind: 'subscribe', channel: 'voice' });
    await tick();
    expect(ws.sent.some((f) => f.kind === 'error' && f.code === 'SUBSCRIBE_FORBIDDEN')).toBe(true);

    emitFrame(ws, { kind: 'subscribe', channel: 'voice', targetId: 'sess-9' });
    await tick();
    expect(conn.isSubscribed('voice', 'sess-9')).toBe(true);
  });

  it('responds to ping with a heartbeat', async () => {
    const ws = new FakeWs();
    makeConn(ws, makeLease().lease);
    ws.sent.length = 0;
    emitFrame(ws, { kind: 'ping' });
    await tick();
    expect(ws.sent.some((f) => f.kind === 'heartbeat')).toBe(true);
  });

  it('emits a PROTOCOL_ERROR on malformed JSON and on a schema-invalid frame', async () => {
    const ws = new FakeWs();
    makeConn(ws, makeLease().lease);
    ws.sent.length = 0;
    ws.emit('message', 'not json{');
    await tick();
    expect(ws.sent.some((f) => f.kind === 'error' && f.code === 'PROTOCOL_ERROR')).toBe(true);

    ws.sent.length = 0;
    emitFrame(ws, { kind: 'subscribe', channel: 'not-a-channel' });
    await tick();
    expect(ws.sent.some((f) => f.kind === 'error' && f.code === 'PROTOCOL_ERROR')).toBe(true);
  });

  it('releases the registry slot exactly once on terminate and refuses sends afterward', async () => {
    const ws = new FakeWs();
    const { lease, raw } = makeLease();
    const conn = makeConn(ws, lease);
    conn.terminate('test_reason');
    expect(conn.isClosed()).toBe(true);
    expect(raw.release).toHaveBeenCalledTimes(1);
    expect(ws.closes).toHaveLength(1);
    // send-after-close is a no-op returning false
    expect(conn.send({ kind: 'heartbeat', serverTimeMs: 1 } as never)).toBe(false);
    // a second terminate does not double-release (onClose is guarded by `closed`)
    conn.terminate('again');
    expect(raw.release).toHaveBeenCalledTimes(1);
  });

  it('terminates on idle timeout', async () => {
    vi.useFakeTimers();
    try {
      const ws = new FakeWs();
      const { lease, raw } = makeLease();
      const conn = makeConn(ws, lease, AUTH, { idleTimeoutMs: 1000 });
      vi.advanceTimersByTime(1001);
      expect(conn.isClosed()).toBe(true);
      expect(raw.release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── attachClientGateway upgrade rejections ───────────────────────────
class FakeSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  remoteAddress = '9.9.9.9';
  write(s: string) {
    this.written.push(s);
    return true;
  }
  destroy() {
    this.destroyed = true;
  }
}

function makeReq(url = CLIENT_GATEWAY_PATH, socket = new FakeSocket()) {
  return { url, headers: {}, socket } as unknown as http.IncomingMessage;
}

describe('attachClientGateway upgrade handler', () => {
  let server: http.Server;
  let handle: ReturnType<typeof attachClientGateway>;

  afterEach(() => {
    handle?.dispose();
    server?.close();
  });

  function attach(deps: Parameters<typeof attachClientGateway>[1]) {
    server = http.createServer();
    handle = attachClientGateway(server, deps);
    return server;
  }

  async function upgrade(req: http.IncomingMessage, socket: FakeSocket) {
    server.emit('upgrade', req, socket, Buffer.alloc(0));
    await tick();
    await tick();
  }

  it('rejects with 401 when auth resolves to null', async () => {
    attach({ auth: { authenticate: async () => null }, registry: makeRegistry().registry });
    const socket = new FakeSocket();
    await upgrade(makeReq(CLIENT_GATEWAY_PATH, socket), socket);
    expect(socket.written[0]).toContain('401');
    expect(socket.destroyed).toBe(true);
  });

  it('rejects with 503 when the runtime kill switch is off', async () => {
    attach({
      auth: { authenticate: async () => AUTH },
      registry: makeRegistry().registry,
      isEnabled: () => false,
    });
    const socket = new FakeSocket();
    await upgrade(makeReq(CLIENT_GATEWAY_PATH, socket), socket);
    expect(socket.written[0]).toContain('503');
  });

  it('rejects with 429 when the registry is full', async () => {
    attach({ auth: { authenticate: async () => AUTH }, registry: makeRegistry(false).registry });
    const socket = new FakeSocket();
    await upgrade(makeReq(CLIENT_GATEWAY_PATH, socket), socket);
    expect(socket.written[0]).toContain('429');
  });

  it('rejects with 429 when the reconnect guard is exhausted', async () => {
    const guard = new ReconnectGuard({ capacity: 1, refillTokensPerSec: 0.1, tightenedFactor: 0.25 });
    // Pre-exhaust the bucket for this ip+tenant.
    guard.tryAdmit({ ip: '9.9.9.9', tenantId: AUTH.tenantId });
    attach({ auth: { authenticate: async () => AUTH }, registry: makeRegistry().registry, reconnectGuard: guard });
    const socket = new FakeSocket();
    await upgrade(makeReq(CLIENT_GATEWAY_PATH, socket), socket);
    expect(socket.written[0]).toContain('429');
  });

  it('ignores upgrades for a non-gateway path', async () => {
    attach({ auth: { authenticate: async () => AUTH }, registry: makeRegistry().registry });
    const socket = new FakeSocket();
    await upgrade(makeReq('/some/other/path', socket), socket);
    expect(socket.written).toHaveLength(0);
  });
});
