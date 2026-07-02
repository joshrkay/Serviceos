/**
 * Cross-instance dispatch-board event transport (UC-4, scale-to-1000).
 *
 * The dispatch board's event bus (board-event-bus.ts) is a process-local
 * listener map, so with >1 replica an event emitted on replica A never reaches
 * SSE/WS clients whose stream terminates on replica B. This transport MIRRORS
 * the small `DispatchBoardEvent` stream over Redis pub/sub so every replica's
 * local subscribers observe changes made anywhere — the exact shape of the
 * shipped voice fan-out (ai/agents/customer-calling/voice-event-transport.ts,
 * U3d).
 *
 * Purely additive and best-effort: the in-process listener map remains the
 * synchronous same-replica path; Redis is an extra mirror that must never
 * throw into the emit site. When REDIS_URL is unset (or the double-gate is
 * off) the transport is a no-op — byte-identical to single-replica behavior.
 */
import { randomUUID } from 'crypto';
import type { DispatchBoardEvent } from './board-event-bus';

/** This process's identity — used to drop self-originated messages on receive. */
export const DISPATCH_REPLICA_ID = randomUUID();

/** Single pub/sub channel; tenant/date routing is in the payload. */
export const DISPATCH_BOARD_EVENTS_CHANNEL = 'dispatch-board-events';

export interface DispatchBoardEventEnvelope {
  /** Originating replica — receivers drop their own messages (no double-fire). */
  replicaId: string;
  tenantId: string;
  event: DispatchBoardEvent;
}

export interface DispatchBoardEventTransport {
  /** Mirror a local event for cross-instance fan-out. Best-effort; never throws. */
  publish(env: DispatchBoardEventEnvelope): void;
  /** Receive events published by OTHER replicas. Register once. */
  subscribe(handler: (env: DispatchBoardEventEnvelope) => void): void;
  close(): Promise<void>;
}

/** No-op transport — the REDIS_URL-unset default (single-replica: local emit is enough). */
export class InProcessDispatchBoardEventTransport implements DispatchBoardEventTransport {
  publish(): void {}
  subscribe(): void {}
  async close(): Promise<void> {}
}

/**
 * Delegating transport that starts no-op and swaps to Redis once connected
 * (mirrors the voice transport's sync-return + async-upgrade so the
 * synchronous composition root is unchanged). Re-registers the subscribe
 * handler on swap so events aren't missed after the upgrade.
 */
class SwappableDispatchBoardEventTransport implements DispatchBoardEventTransport {
  private impl: DispatchBoardEventTransport = new InProcessDispatchBoardEventTransport();
  private handler: ((env: DispatchBoardEventEnvelope) => void) | null = null;
  swap(next: DispatchBoardEventTransport): void {
    this.impl = next;
    if (this.handler) next.subscribe(this.handler);
  }
  publish(env: DispatchBoardEventEnvelope): void {
    this.impl.publish(env);
  }
  subscribe(handler: (env: DispatchBoardEventEnvelope) => void): void {
    this.handler = handler;
    this.impl.subscribe(handler);
  }
  async close(): Promise<void> {
    await this.impl.close();
  }
}

/**
 * Select the transport by REDIS_URL. Returns SYNCHRONOUSLY (no-op) and upgrades
 * to Redis pub/sub in the background when a URL is given. No-op (byte-identical
 * to today) when REDIS_URL is unset.
 */
export function createDispatchBoardEventTransport(redisUrl?: string): DispatchBoardEventTransport {
  if (!redisUrl) return new InProcessDispatchBoardEventTransport();
  const transport = new SwappableDispatchBoardEventTransport();
  void import('./redis-board-fanout')
    .then(({ createRedisDispatchBoardEventTransport }) =>
      createRedisDispatchBoardEventTransport(redisUrl),
    )
    .then((redisTransport) => {
      if (redisTransport) transport.swap(redisTransport);
    })
    .catch(() => {
      // Redis unavailable — stay no-op (local emit only).
    });
  return transport;
}
