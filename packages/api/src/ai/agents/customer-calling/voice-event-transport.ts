/**
 * Cross-instance voice-event transport (scale-to-1000 U3d).
 *
 * A live `VoiceSession` (FSM, cost tracker, EventEmitter) is not serializable and
 * lives entirely on the replica that owns the call (Twilio pins a media-stream to
 * one instance). So we do NOT move sessions across replicas — we only MIRROR the
 * small `VoiceSessionEvent` stream over Redis pub/sub so consumers on OTHER
 * replicas (the escalation/supervisor-wall `subscribeGlobal` sink and the client
 * WS gateway) can observe a call they don't own.
 *
 * The transport is purely additive and best-effort: the in-process EventEmitter
 * remains the synchronous same-replica path (graders, per-session SSE, the
 * AgentEventBus all depend on it being synchronous and ordered); Redis is an
 * extra mirror that must never throw into the FSM emit site. When REDIS_URL is
 * unset the transport is a no-op — byte-identical to single-replica behavior.
 */
import { randomUUID } from 'crypto';
import type { VoiceSessionEvent } from './voice-session-store';

/** This process's identity — used to drop self-originated messages on receive. */
export const REPLICA_ID = randomUUID();

/** Single pub/sub channel; tenant/session routing is in the payload. */
export const VOICE_EVENTS_CHANNEL = 'voice-events';

export interface VoiceEventEnvelope {
  /** Originating replica — receivers drop their own messages (no double-fire). */
  replicaId: string;
  tenantId: string;
  sessionId: string;
  callSid?: string;
  event: VoiceSessionEvent;
}

export interface VoiceEventTransport {
  /** Mirror a local event for cross-instance fan-out. Best-effort; never throws. */
  publish(env: VoiceEventEnvelope): void;
  /** Receive events published by OTHER replicas. Register once. */
  subscribe(handler: (env: VoiceEventEnvelope) => void): void;
  close(): Promise<void>;
}

/** No-op transport — the REDIS_URL-unset default (single-replica: local emit is enough). */
export class InProcessVoiceEventTransport implements VoiceEventTransport {
  publish(): void {}
  subscribe(): void {}
  async close(): Promise<void> {}
}

/**
 * Delegating transport that starts no-op and swaps to Redis once connected
 * (mirrors the connection-registry's sync-return + async-upgrade so the
 * synchronous app composition root is unchanged). Re-registers the subscribe
 * handler on swap so events aren't missed after the upgrade.
 */
class SwappableVoiceEventTransport implements VoiceEventTransport {
  private impl: VoiceEventTransport = new InProcessVoiceEventTransport();
  private handler: ((env: VoiceEventEnvelope) => void) | null = null;
  swap(next: VoiceEventTransport): void {
    this.impl = next;
    if (this.handler) next.subscribe(this.handler);
  }
  publish(env: VoiceEventEnvelope): void {
    this.impl.publish(env);
  }
  subscribe(handler: (env: VoiceEventEnvelope) => void): void {
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
export function createVoiceEventTransport(redisUrl?: string): VoiceEventTransport {
  if (!redisUrl) return new InProcessVoiceEventTransport();
  const transport = new SwappableVoiceEventTransport();
  void import('./redis-voice-event-transport')
    .then(({ createRedisVoiceEventTransport }) => createRedisVoiceEventTransport(redisUrl))
    .then((redisTransport) => {
      if (redisTransport) transport.swap(redisTransport);
    })
    .catch(() => {
      // Redis unavailable — stay no-op (local emit only).
    });
  return transport;
}
