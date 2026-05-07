/**
 * VQ-003 — AgentEventBus.
 *
 * A thin facade over `VoiceSession.events` (the existing per-session
 * EventEmitter, channel name `'voice-event'`). Subscribes to one or
 * more sessions and accumulates a unified, ordered observation log
 * that the Voice Quality harness — and graders — read after each
 * scripted call to assert side effects without reaching into adapter
 * internals.
 *
 * Important: this class deliberately does NOT own its own EventEmitter.
 * The substrate is the per-session emitter the SSE route already
 * subscribes to. We just listen on the same channel so adapter emits
 * fan out to both production consumers (SSE) and the harness (us)
 * without any code change on the producer side.
 *
 * Locking: subscriber callbacks here are synchronous (.push) and never
 * touch `VoiceSessionStore.withSessionLock`, so subscribing the bus
 * cannot deadlock against the per-session promise chain.
 */
import type {
  VoiceSession,
  VoiceSessionEvent,
} from '../agents/customer-calling/voice-session-store';

/** Channel name used by every existing emit site in the codebase. */
export const VOICE_EVENT_CHANNEL = 'voice-event';

export class AgentEventBus {
  private observed: VoiceSessionEvent[] = [];
  /**
   * Track which sessions we've subscribed to plus the listener we
   * registered, so `unsubscribeAll` can detach cleanly. Without this,
   * a long-running harness that recycles sessions would slowly leak
   * listeners against the EventEmitter (>20 → Node warns).
   */
  private readonly subscriptions = new Map<
    string,
    { session: VoiceSession; listener: (event: VoiceSessionEvent) => void }
  >();

  /** Begin observing events emitted on `session.events`. Idempotent per session id. */
  subscribe(session: VoiceSession): void {
    if (this.subscriptions.has(session.id)) return;
    const listener = (event: VoiceSessionEvent): void => {
      this.observed.push(event);
    };
    session.events.on(VOICE_EVENT_CHANNEL, listener);
    this.subscriptions.set(session.id, { session, listener });
  }

  /** Stop observing a single session. No-op when not subscribed. */
  unsubscribe(session: VoiceSession): void {
    const sub = this.subscriptions.get(session.id);
    if (!sub) return;
    sub.session.events.off(VOICE_EVENT_CHANNEL, sub.listener);
    this.subscriptions.delete(session.id);
  }

  /** Detach from every session this bus subscribed to. Tests should call this in afterEach. */
  unsubscribeAll(): void {
    for (const { session, listener } of this.subscriptions.values()) {
      session.events.off(VOICE_EVENT_CHANNEL, listener);
    }
    this.subscriptions.clear();
  }

  /** Read-only view of the captured event log, in emit order. */
  events(): readonly VoiceSessionEvent[] {
    return this.observed;
  }

  /**
   * Append an externally-synthesized event directly to the captured
   * log. Used by the harness runner to stamp a `session_terminated
   * { cause: 'completed' }` event for clean (non-hangup) script ends —
   * the production driver only emits `session_terminated` for
   * hangup/cost-cap paths, and the runner doesn't hold a session ref
   * after `endSession()` runs. Callers must be content with appending
   * AFTER any subscribed-session events that have already arrived.
   */
  record(event: VoiceSessionEvent): void {
    this.observed.push(event);
  }

  /** Reset the captured log. Subscriptions are preserved. */
  clear(): void {
    this.observed = [];
  }

  /** Return only events of a specific discriminant, narrowed to that variant. */
  filterByType<T extends VoiceSessionEvent['type']>(
    type: T,
  ): Array<Extract<VoiceSessionEvent, { type: T }>> {
    return this.observed.filter((e) => e.type === type) as Array<
      Extract<VoiceSessionEvent, { type: T }>
    >;
  }
}
