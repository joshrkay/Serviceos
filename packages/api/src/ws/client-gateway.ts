/**
 * Client-facing WebSocket gateway.
 *
 * Mounted at /api/ws. Authenticates the upgrade with a Bearer token
 * (Clerk-issued) read from `Sec-WebSocket-Protocol` (subprotocol) or the
 * `?token=` query param. On accept:
 *   - Resolve tenant from auth.
 *   - Acquire a slot in the per-tenant ConnectionRegistry.
 *   - Construct a per-connection ClientGatewayConnection that owns a
 *     bounded outbound queue + heartbeat loop.
 *
 * Producers (assistant chat token stream, voice FSM events) push frames
 * into this connection by channel. The connection enforces priority,
 * coalescing, and slow-consumer disconnect via BoundedSendQueue.
 *
 * SSE endpoints remain functional; this gateway is gated by feature
 * flags. The web client opts in based on a runtime flag.
 */
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Socket } from 'net';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { createLogger } from '../logging/logger';
import { BoundedSendQueue, type Priority } from './bounded-send-queue';
import {
  globalConnectionRegistry,
  ConnectionRegistry,
} from './connection-registry';
import {
  ReconnectGuard,
  isMemoryWatermarkHigh,
} from './reconnect-guard';
import {
  WS_CLOSE_CODE,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_IDLE_TIMEOUT_MS,
  priorityForFrame,
  wsClientFrameSchema,
  type WsClientFrame,
  type WsServerFrame,
} from './protocol';
import {
  wsConnections,
  wsDisconnectTotal,
  wsSendLatencyMs,
} from '../monitoring/metrics';

const logger = createLogger({
  service: 'ws.client-gateway',
  environment: process.env.NODE_ENV || 'development',
});

const SURFACE = 'client_gateway';
export const CLIENT_GATEWAY_PATH = '/api/ws';

export interface AuthResolver {
  /** Resolve auth from upgrade request. Return null to reject 401. */
  authenticate(req: IncomingMessage): Promise<AuthResult | null> | AuthResult | null;
}

export interface AuthResult {
  tenantId: string;
  userId?: string;
  tenantTier?: string;
}

export interface ClientGatewayDeps {
  auth: AuthResolver;
  registry?: ConnectionRegistry;
  reconnectGuard?: ReconnectGuard;
  heartbeatIntervalMs?: number;
  idleTimeoutMs?: number;
  /** Per-connection queue caps. */
  queueMaxMsgs?: number;
  queueMaxBytes?: number;
  /**
   * Runtime kill switch — consulted on every upgrade. When this returns
   * false, the upgrade is rejected with 503 even if the gateway was
   * attached on boot. Lets operators disable the gateway via the
   * persisted feature flag without a redeploy.
   */
  isEnabled?: () => boolean;
}

export interface AttachClientGatewayOptions {
  enabled?: boolean;
}

export class ClientGatewayConnection {
  readonly tenantId: string;
  readonly userId?: string;
  readonly tenantTier: string;
  private seq = 0;
  private readonly queue: BoundedSendQueue;
  private readonly heartbeatTimer: NodeJS.Timeout;
  private idleTimer: NodeJS.Timeout | null = null;
  private subscriptions: Set<string> = new Set();
  private closed = false;
  private draining = false;

  constructor(
    private readonly ws: WebSocket,
    auth: AuthResult,
    private readonly registry: ConnectionRegistry,
    cfg: {
      heartbeatIntervalMs: number;
      idleTimeoutMs: number;
      queueMaxMsgs: number;
      queueMaxBytes: number;
    },
  ) {
    this.tenantId = auth.tenantId;
    this.userId = auth.userId;
    this.tenantTier = auth.tenantTier ?? 'standard';

    this.queue = new BoundedSendQueue({
      surface: SURFACE,
      maxMsgs: cfg.queueMaxMsgs,
      maxBytes: cfg.queueMaxBytes,
      highWatermark: 0.7,
      coalesce: (a, b) => {
        // Concatenate adjacent same-key delta frames.
        try {
          const pa = JSON.parse(a.data);
          const pb = JSON.parse(b.data);
          if (typeof pa.delta === 'string' && typeof pb.delta === 'string') {
            const merged = { ...pa, delta: pa.delta + pb.delta, degraded: true };
            return { priority: a.priority, data: JSON.stringify(merged), coalesceKey: a.coalesceKey };
          }
        } catch {
          /* fall through */
        }
        return b;
      },
    });

    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      this.send({
        kind: 'heartbeat',
        serverTimeMs: Date.now(),
      });
    }, cfg.heartbeatIntervalMs);
    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
    this.armIdleTimer(cfg.idleTimeoutMs);

    ws.on('message', (data) => this.onMessage(data));
    ws.on('close', () => this.onClose('client_close'));
    ws.on('error', () => this.onClose('ws_error'));

    this.send({
      kind: 'hello',
      serverTimeMs: Date.now(),
      heartbeatIntervalMs: cfg.heartbeatIntervalMs,
    });
  }

  /** Push a server frame to the client. */
  send(frame: WsServerFrame): boolean {
    if (this.closed) return false;
    const sized: WsServerFrame = {
      ...frame,
      seq: frame.seq ?? ++this.seq,
    } as WsServerFrame;
    const priority: Priority = priorityForFrame(sized);
    const data = JSON.stringify(sized);
    const coalesceKey =
      sized.kind === 'assistant.token'
        ? `assistant:${sized.correlationId ?? 'default'}`
        : undefined;

    const accepted = this.queue.enqueue({ priority, data, coalesceKey });
    if (!accepted && priority === 'terminal') {
      this.terminate('queue_overflow_terminal');
    }
    void this.flush();
    return accepted;
  }

  /**
   * True when the connection is subscribed to the given channel/target.
   *
   * Exact match only — a `subscribe` with no targetId does NOT receive
   * frames broadcast to a specific target, and a per-target subscription
   * does not receive untargeted frames. This prevents cross-user
   * leakage on the assistant channel where tokens are published per
   * userId.
   */
  isSubscribed(channel: 'assistant' | 'voice', targetId?: string): boolean {
    const key = `${channel}:${targetId ?? '*'}`;
    return this.subscriptions.has(key);
  }

  channels(): string[] {
    return Array.from(this.subscriptions);
  }

  terminate(reason: string, code: number = WS_CLOSE_CODE.policy_violation): void {
    if (this.closed) return;
    // Disconnect counter is incremented inside onClose() to avoid
    // double-counting server-initiated closes (idle timeout, slow
    // consumer, shutdown).
    try {
      this.ws.close(code, reason);
    } catch {
      /* swallow */
    }
    this.onClose(reason);
  }

  private async flush(): Promise<void> {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      await this.queue.drain((frame) => {
        const start = Date.now();
        this.ws.send(frame.data);
        wsSendLatencyMs.observe({ surface: SURFACE }, Date.now() - start);
      });
    } catch (err) {
      logger.warn('client-gateway: drain error', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.draining = false;
    }
    this.checkSlowConsumer();
  }

  private checkSlowConsumer(): void {
    const stats = this.queue.stats();
    if (stats.consecutiveOverWatermarkMs > 8_000 || stats.ewmaSendLatencyMs > 500) {
      this.terminate('slow_consumer', WS_CLOSE_CODE.policy_violation);
    }
  }

  private onMessage(raw: RawData): void {
    let parsed: WsClientFrame;
    try {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      const json = JSON.parse(text);
      const result = wsClientFrameSchema.safeParse(json);
      if (!result.success) {
        this.send({
          kind: 'error',
          code: 'PROTOCOL_ERROR',
          message: 'Invalid client frame',
        });
        return;
      }
      parsed = result.data;
    } catch {
      this.send({
        kind: 'error',
        code: 'PROTOCOL_ERROR',
        message: 'Malformed JSON',
      });
      return;
    }
    this.armIdleTimer();

    switch (parsed.kind) {
      case 'subscribe': {
        // Authorize the subscription target. Without this, any tenant
        // member could subscribe to assistant:<otherUserId> and harvest
        // another operator's token stream.
        const reason = this.authorizeSubscribe(parsed.channel, parsed.targetId);
        if (reason) {
          this.send({
            kind: 'error',
            code: 'SUBSCRIBE_FORBIDDEN',
            message: reason,
          });
          return;
        }
        const key = `${parsed.channel}:${parsed.targetId ?? '*'}`;
        this.subscriptions.add(key);
        this.send({ kind: 'subscribed', channel: parsed.channel });
        return;
      }
      case 'unsubscribe': {
        const key = `${parsed.channel}:${parsed.targetId ?? '*'}`;
        this.subscriptions.delete(key);
        return;
      }
      case 'ping': {
        this.send({ kind: 'heartbeat', serverTimeMs: Date.now() });
        return;
      }
    }
  }

  /**
   * Returns null when the subscription is allowed, or a reason string
   * to refuse. The assistant channel is per-user; voice subscriptions
   * must specify a session id (tenant filter on broadcast prevents
   * cross-tenant leakage). Untargeted subscriptions are not honored —
   * see isSubscribed for the matching policy.
   */
  private authorizeSubscribe(
    channel: 'assistant' | 'voice',
    targetId: string | undefined,
  ): string | null {
    if (channel === 'assistant') {
      if (!targetId) return 'assistant subscriptions require a targetId';
      if (!this.userId || targetId !== this.userId) {
        return 'assistant target must match the authenticated user';
      }
      return null;
    }
    if (channel === 'voice') {
      if (!targetId) return 'voice subscriptions require a session id';
      return null;
    }
    return 'unsupported channel';
  }

  private onClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.subscriptions.clear();
    this.queue.clear();
    this.registry.release(SURFACE, this.tenantId, this.tenantTier);
    wsDisconnectTotal.inc({ surface: SURFACE, reason });
  }

  private armIdleTimer(timeoutMs: number = WS_IDLE_TIMEOUT_MS): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.terminate('idle_timeout', WS_CLOSE_CODE.normal);
    }, timeoutMs);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  isClosed(): boolean {
    return this.closed;
  }
}

export interface ClientGatewayHandle {
  dispose: () => void;
  /** Broadcast to every connection subscribed to (channel, targetId). */
  broadcast: (
    channel: 'assistant' | 'voice',
    targetId: string | undefined,
    frame: WsServerFrame,
    tenantId?: string,
  ) => number;
  /** Number of currently-open connections. */
  size: () => number;
}

/**
 * Module-level publisher seat. The gateway registers its broadcast fn
 * here at attach time; routes call `publish(...)` without needing a
 * direct reference to the gateway handle. When the gateway is disabled,
 * `publish` is a no-op.
 *
 * Operators can additionally gate per-channel mirroring by setting a
 * `channelGate` — used by app.ts to honor the
 * `ws.assistant_stream_enabled` / `ws.voice_events_enabled` kill
 * switches at runtime so flipping a flag immediately stops
 * publishing without a redeploy.
 */
let activePublisher: ClientGatewayHandle['broadcast'] | null = null;
let channelGate: ((channel: 'assistant' | 'voice', tenantId?: string) => boolean) | null = null;

export function publish(
  channel: 'assistant' | 'voice',
  targetId: string | undefined,
  frame: WsServerFrame,
  tenantId?: string,
): number {
  if (!activePublisher) return 0;
  if (channelGate && !channelGate(channel, tenantId)) return 0;
  return activePublisher(channel, targetId, frame, tenantId);
}

export function setChannelGate(
  gate: ((channel: 'assistant' | 'voice', tenantId?: string) => boolean) | null,
): void {
  channelGate = gate;
}

export function isClientGatewayEnabled(): boolean {
  return activePublisher !== null;
}

export function attachClientGateway(
  httpServer: HttpServer,
  deps: ClientGatewayDeps,
  opts: AttachClientGatewayOptions = {},
): ClientGatewayHandle {
  const enabled = opts.enabled ?? true;
  if (!enabled) {
    logger.info('client gateway NOT attached (flag disabled)');
    return {
      dispose: () => {},
      broadcast: () => 0,
      size: () => 0,
    };
  }

  const registry = deps.registry ?? globalConnectionRegistry;
  const guard = deps.reconnectGuard ?? new ReconnectGuard();
  const wss = new WebSocketServer({ noServer: true });
  const conns: Set<ClientGatewayConnection> = new Set();
  // Indexed by tenantId so per-tenant broadcast (the hot path for
  // assistant token streaming) is O(subscribers) rather than O(total
  // connections). Without this index, a 1000-connection process pays
  // 1000 iterations per token frame across all tenants.
  const byTenant: Map<string, Set<ClientGatewayConnection>> = new Map();

  const cfg = {
    heartbeatIntervalMs: deps.heartbeatIntervalMs ?? WS_HEARTBEAT_INTERVAL_MS,
    idleTimeoutMs: deps.idleTimeoutMs ?? WS_IDLE_TIMEOUT_MS,
    queueMaxMsgs: deps.queueMaxMsgs ?? 200,
    queueMaxBytes: deps.queueMaxBytes ?? 4 * 1024 * 1024,
  };

  const upgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const url = req.url ?? '';
    const pathOnly = url.split('?')[0];
    if (pathOnly !== CLIENT_GATEWAY_PATH) return;

    // Runtime kill switch: if the operator has flipped
    // ws.client_gateway_enabled off, reject the upgrade. We still own
    // the path (don't delegate), so a stale client can't slip past us.
    if (deps.isEnabled && !deps.isEnabled()) {
      rejectUpgrade(socket, 503);
      return;
    }

    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      'unknown';

    Promise.resolve(deps.auth.authenticate(req))
      .then((auth) => {
        if (!auth) {
          rejectUpgrade(socket, 401);
          return;
        }

        const retryMs = guard.tryAdmit({
          ip,
          tenantId: auth.tenantId,
          tighten: isMemoryWatermarkHigh(),
        });
        if (retryMs > 0) {
          rejectUpgrade(socket, 429, retryMs);
          return;
        }

        if (!registry.tryAcquire(SURFACE, auth.tenantId, auth.tenantTier ?? 'standard')) {
          rejectUpgrade(socket, 429, 1_000);
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          const conn = new ClientGatewayConnection(ws, auth, registry, cfg);
          conns.add(conn);
          let bucket = byTenant.get(auth.tenantId);
          if (!bucket) {
            bucket = new Set();
            byTenant.set(auth.tenantId, bucket);
          }
          bucket.add(conn);
          ws.once('close', () => {
            conns.delete(conn);
            const b = byTenant.get(auth.tenantId);
            if (b) {
              b.delete(conn);
              if (b.size === 0) byTenant.delete(auth.tenantId);
            }
          });
        });
      })
      .catch((err) => {
        logger.warn('client-gateway upgrade error', {
          error: err instanceof Error ? err.message : String(err),
        });
        rejectUpgrade(socket, 500);
      });
  };

  httpServer.on('upgrade', upgradeHandler);
  logger.info('client gateway attached', { path: CLIENT_GATEWAY_PATH });

  const broadcast: ClientGatewayHandle['broadcast'] = (
    channel,
    targetId,
    frame,
    tenantId,
  ) => {
    let n = 0;
    // Tenant-scoped broadcasts (the common case) walk only that
    // tenant's bucket. Cross-tenant broadcasts (rare; admin/system
    // surfaces) fall through to the full set.
    const pool = tenantId ? byTenant.get(tenantId) : conns;
    if (!pool) return 0;
    for (const conn of pool) {
      if (conn.isClosed()) continue;
      if (tenantId && conn.tenantId !== tenantId) continue;
      if (!conn.isSubscribed(channel, targetId)) continue;
      if (conn.send(frame as WsServerFrame)) n++;
    }
    return n;
  };
  activePublisher = broadcast;

  return {
    dispose: () => {
      httpServer.off('upgrade', upgradeHandler);
      for (const conn of conns) conn.terminate('server_shutdown', WS_CLOSE_CODE.going_away);
      conns.clear();
      byTenant.clear();
      wss.close();
      if (activePublisher === broadcast) activePublisher = null;
    },
    broadcast,
    size: () => {
      wsConnections.set({ surface: SURFACE, tenant_tier: 'aggregate' }, conns.size);
      return conns.size;
    },
  };
}

function rejectUpgrade(
  socket: Socket,
  code: 401 | 429 | 500 | 503,
  retryAfterMs?: number,
): void {
  const reason =
    code === 401
      ? 'Unauthorized'
      : code === 429
        ? 'Too Many Requests'
        : code === 503
          ? 'Service Unavailable'
          : 'Internal Server Error';
  const headers = ['Connection: close'];
  if ((code === 429 || code === 503) && retryAfterMs) {
    headers.push(`Retry-After: ${Math.ceil(retryAfterMs / 1000)}`);
  }
  socket.write(`HTTP/1.1 ${code} ${reason}\r\n${headers.join('\r\n')}\r\n\r\n`);
  try {
    socket.destroy();
  } catch {
    /* swallow */
  }
}
