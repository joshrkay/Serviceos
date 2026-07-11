/**
 * WS3 (voice ingestion resilience) — in-process circuit breaker for the
 * realtime (Twilio Media Streams) voice path.
 *
 * The realtime path is the newer, less-proven transport. When it fails to
 * establish a session repeatedly (Deepgram won't open, recording disclosure
 * bootstrap throws), we must stop steering new calls at it and let the /voice
 * route degrade to the proven legacy Gather path until the transport recovers.
 *
 * This breaker is the "recent failures" signal the /voice TwiML branch consults
 * (via {@link isOpen}) and the mediastream adapter feeds (via
 * {@link recordFailure} / {@link recordSuccess}) at its session-establishment
 * and terminal-failure sites.
 *
 * Design constraints (deliberately dead simple):
 *   - Pure + in-process. No I/O, no timers. State is three fields.
 *   - Deterministic. Time is read from an injectable {@link Clock} so tests
 *     can advance it explicitly rather than sleeping.
 *   - Consecutive-failure threshold to OPEN; a TTL after which the next
 *     {@link isOpen} check HALF-OPENs (returns closed for one probe). A
 *     subsequent failure re-opens immediately (the failure count is not reset
 *     on half-open, so a single failure is back over threshold); a success
 *     fully resets.
 *
 * Scope: a single process-wide instance is shared between the route (read) and
 * the adapter (write) — it is NOT per-tenant. A realtime transport outage
 * (Deepgram down, TTS misconfigured) is a global capability failure, so a
 * global trip that protects every tenant is the intended blast radius.
 */

export interface Clock {
  now(): number;
}

const systemClock: Clock = { now: () => Date.now() };

export interface RealtimeHealthCircuitOptions {
  /** Consecutive realtime session failures required to OPEN. Default 2. */
  threshold?: number;
  /** Milliseconds after opening before the next isOpen() half-opens. Default 60_000. */
  ttlMs?: number;
  /** Injectable clock — defaults to Date.now(). Tests pass a mutable stub. */
  clock?: Clock;
}

export class RealtimeHealthCircuit {
  private consecutiveFailures = 0;
  /** Epoch millis when the breaker last opened; null while closed. */
  private openedAt: number | null = null;
  private readonly threshold: number;
  private readonly ttlMs: number;
  private readonly clock: Clock;

  constructor(opts: RealtimeHealthCircuitOptions = {}) {
    this.threshold = Math.max(1, opts.threshold ?? 2);
    this.ttlMs = Math.max(0, opts.ttlMs ?? 60_000);
    this.clock = opts.clock ?? systemClock;
  }

  /**
   * Record a realtime session failure (Deepgram open failure, disclosure
   * bootstrap failure, or any equivalent pre-conversation terminal failure).
   * `kind` is retained for the caller's own logging/metrics; the breaker only
   * counts. Opens once `threshold` consecutive failures accumulate.
   */
  recordFailure(_kind: string): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.threshold) {
      this.openedAt = this.clock.now();
    }
  }

  /** Record a realtime session that established cleanly. Fully resets the breaker. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  /**
   * True while the breaker is tripped and the TTL has not yet elapsed. Once the
   * TTL passes, the FIRST call transitions to half-open — it clears the open
   * marker and returns false so exactly one probe call is allowed through. If
   * that probe fails, {@link recordFailure} re-opens immediately (the failure
   * count was never reset); if it succeeds, {@link recordSuccess} clears it.
   */
  isOpen(): boolean {
    if (this.openedAt === null) return false;
    const elapsed = this.clock.now() - this.openedAt;
    if (elapsed >= this.ttlMs) {
      // Half-open: allow the next probe through. Leave consecutiveFailures
      // intact so a single failing probe trips straight back open.
      this.openedAt = null;
      return false;
    }
    return true;
  }
}
