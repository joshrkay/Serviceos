/**
 * Redis pub/sub implementation of the voice-event transport (scale-to-1000 U3d).
 *
 * Uses two connections: a dedicated SUBSCRIBE connection (an ioredis client in
 * subscriber mode cannot issue normal commands) and a command connection for
 * PUBLISH. Everything is best-effort — a publish/subscribe failure must never
 * propagate into the synchronous FSM emit site, so all calls swallow errors
 * (mirrors RedisCacheStore's stance).
 */
import type { Redis } from 'ioredis';
import { createRedisClient, registerRedisClientForShutdown } from '../../../redis/redis-client';
import {
  VOICE_EVENTS_CHANNEL,
  type VoiceEventTransport,
  type VoiceEventEnvelope,
} from './voice-event-transport';

export class RedisVoiceEventTransport implements VoiceEventTransport {
  constructor(
    private readonly pub: Redis,
    private readonly sub: Redis,
  ) {}

  publish(env: VoiceEventEnvelope): void {
    try {
      void this.pub.publish(VOICE_EVENTS_CHANNEL, JSON.stringify(env)).catch(() => {});
    } catch {
      // best-effort — a serialization/connection error must not reach the FSM.
    }
  }

  subscribe(handler: (env: VoiceEventEnvelope) => void): void {
    this.sub.on('message', (channel: string, raw: string) => {
      if (channel !== VOICE_EVENTS_CHANNEL) return;
      try {
        handler(JSON.parse(raw) as VoiceEventEnvelope);
      } catch {
        // ignore malformed payloads.
      }
    });
    void this.sub.subscribe(VOICE_EVENTS_CHANNEL).catch(() => {});
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
 * Build a RedisVoiceEventTransport from REDIS_URL (a command + a subscriber
 * connection), or null when unset/unreachable (caller stays no-op). Both clients
 * are registered for SIGTERM shutdown.
 */
export async function createRedisVoiceEventTransport(
  redisUrl?: string,
): Promise<RedisVoiceEventTransport | null> {
  const pub = await createRedisClient(redisUrl, { role: 'command' });
  if (!pub) return null;
  const sub = await createRedisClient(redisUrl, { role: 'subscriber' });
  if (!sub) {
    await pub.quit().catch(() => {});
    return null;
  }
  registerRedisClientForShutdown(pub);
  registerRedisClientForShutdown(sub);
  return new RedisVoiceEventTransport(pub, sub);
}
