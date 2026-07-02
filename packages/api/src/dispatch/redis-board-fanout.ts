/**
 * Redis pub/sub implementation of the dispatch-board event transport (UC-4).
 *
 * Uses two connections: a dedicated SUBSCRIBE connection (an ioredis client in
 * subscriber mode cannot issue normal commands) and a command connection for
 * PUBLISH. Everything is best-effort — a publish/subscribe failure must never
 * propagate into the synchronous emit site, so all calls swallow errors
 * (mirrors redis-voice-event-transport.ts / RedisCacheStore's stance).
 */
import type { Redis } from 'ioredis';
import { createRedisClient, registerRedisClientForShutdown } from '../redis/redis-client';
import {
  DISPATCH_BOARD_EVENTS_CHANNEL,
  type DispatchBoardEventTransport,
  type DispatchBoardEventEnvelope,
} from './board-fanout';

export class RedisDispatchBoardEventTransport implements DispatchBoardEventTransport {
  constructor(
    private readonly pub: Redis,
    private readonly sub: Redis,
  ) {}

  publish(env: DispatchBoardEventEnvelope): void {
    try {
      void this.pub.publish(DISPATCH_BOARD_EVENTS_CHANNEL, JSON.stringify(env)).catch(() => {});
    } catch {
      // best-effort — a serialization/connection error must not reach the emit site.
    }
  }

  subscribe(handler: (env: DispatchBoardEventEnvelope) => void): void {
    this.sub.on('message', (channel: string, raw: string) => {
      if (channel !== DISPATCH_BOARD_EVENTS_CHANNEL) return;
      try {
        handler(JSON.parse(raw) as DispatchBoardEventEnvelope);
      } catch {
        // ignore malformed payloads.
      }
    });
    void this.sub.subscribe(DISPATCH_BOARD_EVENTS_CHANNEL).catch(() => {});
  }

  async close(): Promise<void> {
    try {
      await this.pub.quit();
    } catch {
      /* ignore */
    }
    try {
      await this.sub.quit();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Build a RedisDispatchBoardEventTransport from REDIS_URL (a command + a
 * subscriber connection), or null when unset/unreachable (caller stays no-op).
 * Both clients are registered for SIGTERM shutdown.
 */
export async function createRedisDispatchBoardEventTransport(
  redisUrl?: string,
): Promise<RedisDispatchBoardEventTransport | null> {
  const pub = await createRedisClient(redisUrl, { role: 'command' });
  if (!pub) return null;
  const sub = await createRedisClient(redisUrl, { role: 'subscriber' });
  if (!sub) {
    await pub.quit().catch(() => {});
    return null;
  }
  registerRedisClientForShutdown(pub);
  registerRedisClientForShutdown(sub);
  return new RedisDispatchBoardEventTransport(pub, sub);
}
