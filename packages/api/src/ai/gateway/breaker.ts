/**
 * Per-cell circuit breaker with hysteresis.
 *
 * Cells are keyed by `{provider, model_family, region, tenant_tier}` so
 * a single misbehaving combination can't take down the whole gateway.
 *
 * State machine:
 *   closed
 *     -> open  when (rolling 20s window): count >= countThreshold AND
 *                  failure_rate >= failureRate, OR consecutive_failures
 *                  >= consecutiveFailureThreshold.
 *     -> closed otherwise.
 *   open
 *     -> half-open after cooldown (10s, exponential up to 60s on reopen).
 *   half-open
 *     -> closed when (probe success ratio >= halfOpenSuccessRatio AND probes
 *                     reached halfOpenProbeCount).
 *     -> open   on first failure.
 *
 * State transitions are serialized per key by the JS event loop (single
 * threaded). Monotonic clock (process.hrtime) is used for timers.
 */
import {
  breakerState,
  breakerTransitionsTotal,
  breakerOpenSecondsTotal,
  breakerHalfOpenProbeSuccessRatio,
} from '../../monitoring/metrics';

export type BreakerStateName = 'closed' | 'open' | 'half-open';

export interface BreakerConfig {
  windowMs: number;
  countThreshold: number;
  failureRate: number;
  consecutiveFailureThreshold: number;
  cooldownMs: number;
  cooldownCapMs: number;
  halfOpenProbeCount: number;
  halfOpenSuccessRatio: number;
}

export const DEFAULT_BREAKER: BreakerConfig = {
  windowMs: 20_000,
  countThreshold: 40,
  failureRate: 0.5,
  consecutiveFailureThreshold: 12,
  cooldownMs: 10_000,
  cooldownCapMs: 60_000,
  halfOpenProbeCount: 5,
  halfOpenSuccessRatio: 0.8,
};

export class BreakerOpenError extends Error {
  readonly code = 'BREAKER_OPEN';
  readonly key: string;
  readonly retryAfterMs: number;
  constructor(key: string, retryAfterMs: number) {
    super(`Circuit breaker open for ${key}; retry after ${retryAfterMs}ms`);
    this.key = key;
    this.retryAfterMs = retryAfterMs;
    this.name = 'BreakerOpenError';
  }
}

interface Sample {
  ts: number;
  success: boolean;
}

function nowMs(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1_000_000;
}

const STATE_VALUE: Record<BreakerStateName, number> = {
  closed: 0,
  'half-open': 1,
  open: 2,
};

class BreakerCell {
  private state: BreakerStateName = 'closed';
  private samples: Sample[] = [];
  private consecutiveFailures = 0;
  private openedAtMs = 0;
  private currentCooldownMs: number;
  private halfOpenProbes = 0;
  private halfOpenSuccesses = 0;
  /**
   * Slots reserved by `canPass()` while a probe is in flight. Without
   * this, concurrent callers all see `halfOpenProbes < N` and bypass
   * the probe cap, flooding a recovering backend.
   */
  private halfOpenReserved = 0;
  private reopenStreak = 0;

  constructor(
    readonly key: string,
    readonly cfg: BreakerConfig,
  ) {
    this.currentCooldownMs = cfg.cooldownMs;
    breakerState.set({ key }, STATE_VALUE.closed);
  }

  /**
   * Read-only check: would a request be admitted right now? Does NOT
   * mutate state. Use `tryReserve()` from the run() path to atomically
   * reserve a half-open probe slot.
   */
  canPass(): boolean {
    this.refreshState();
    if (this.state === 'open') return false;
    if (this.state === 'half-open') {
      return this.halfOpenProbes + this.halfOpenReserved < this.cfg.halfOpenProbeCount;
    }
    return true;
  }

  /**
   * Atomic gate used by CircuitBreakerRegistry.run(): returns true if
   * the request may proceed, and reserves a half-open probe slot when
   * applicable. Without this reservation, concurrent half-open callers
   * all see `halfOpenProbes < N` and bypass the probe cap, flooding a
   * recovering backend.
   */
  tryReserve(): boolean {
    this.refreshState();
    if (this.state === 'open') return false;
    if (this.state === 'half-open') {
      if (this.halfOpenProbes + this.halfOpenReserved >= this.cfg.halfOpenProbeCount) {
        return false;
      }
      this.halfOpenReserved++;
      return true;
    }
    return true;
  }

  retryAfterMs(): number {
    if (this.state !== 'open') return 0;
    const elapsed = nowMs() - this.openedAtMs;
    return Math.max(0, this.currentCooldownMs - elapsed);
  }

  /** Release a probe reservation without recording a result (e.g.
   *  caller short-circuited before invoking the wrapped op, or chose
   *  not to count the outcome — see CircuitBreakerRegistry.run()). */
  releaseReservation(): void {
    if (this.state === 'half-open' && this.halfOpenReserved > 0) {
      this.halfOpenReserved--;
    }
  }

  onResult(success: boolean): void {
    if (this.state === 'half-open') {
      if (this.halfOpenReserved > 0) this.halfOpenReserved--;
      this.halfOpenProbes++;
      if (success) this.halfOpenSuccesses++;
      const ratio = this.halfOpenProbes === 0
        ? 1
        : this.halfOpenSuccesses / this.halfOpenProbes;
      breakerHalfOpenProbeSuccessRatio.set({ key: this.key }, ratio);

      if (!success) {
        this.transition('open');
        return;
      }
      if (this.halfOpenProbes >= this.cfg.halfOpenProbeCount) {
        if (ratio >= this.cfg.halfOpenSuccessRatio) {
          this.transition('closed');
        } else {
          this.transition('open');
        }
      }
      return;
    }

    const now = nowMs();
    this.samples.push({ ts: now, success });
    this.prune(now);
    this.consecutiveFailures = success ? 0 : this.consecutiveFailures + 1;

    if (this.shouldOpen()) {
      this.transition('open');
    }
  }

  getState(): BreakerStateName {
    this.refreshState();
    return this.state;
  }

  private refreshState(): void {
    if (this.state === 'open') {
      const elapsed = nowMs() - this.openedAtMs;
      if (elapsed >= this.currentCooldownMs) {
        this.transition('half-open');
      }
    }
  }

  private shouldOpen(): boolean {
    if (this.consecutiveFailures >= this.cfg.consecutiveFailureThreshold) return true;
    const total = this.samples.length;
    if (total < this.cfg.countThreshold) return false;
    const failures = this.samples.filter((s) => !s.success).length;
    return failures / total >= this.cfg.failureRate;
  }

  private transition(to: BreakerStateName): void {
    if (to === this.state) return;
    const from = this.state;

    if (from === 'open') {
      const openSeconds = (nowMs() - this.openedAtMs) / 1000;
      breakerOpenSecondsTotal.inc({ key: this.key }, openSeconds);
    }

    breakerTransitionsTotal.inc({ key: this.key, from, to });
    this.state = to;
    breakerState.set({ key: this.key }, STATE_VALUE[to]);

    if (to === 'open') {
      // Exponential cooldown on reopen, capped.
      this.reopenStreak++;
      if (from === 'half-open') {
        this.currentCooldownMs = Math.min(
          this.cfg.cooldownCapMs,
          this.currentCooldownMs * 2,
        );
      } else {
        this.currentCooldownMs = this.cfg.cooldownMs;
      }
      this.openedAtMs = nowMs();
      this.halfOpenProbes = 0;
      this.halfOpenSuccesses = 0;
      this.halfOpenReserved = 0;
    } else if (to === 'half-open') {
      this.halfOpenProbes = 0;
      this.halfOpenSuccesses = 0;
      this.halfOpenReserved = 0;
    } else {
      // closed: reset everything, decay reopen streak.
      this.samples = [];
      this.consecutiveFailures = 0;
      this.halfOpenProbes = 0;
      this.halfOpenSuccesses = 0;
      this.halfOpenReserved = 0;
      this.reopenStreak = 0;
      this.currentCooldownMs = this.cfg.cooldownMs;
    }
  }

  private prune(now: number): void {
    const cutoff = now - this.cfg.windowMs;
    if (this.samples.length === 0) return;
    if (this.samples[0].ts >= cutoff) return;
    this.samples = this.samples.filter((s) => s.ts >= cutoff);
  }
}

export interface BreakerKeyParts {
  provider: string;
  modelFamily: string;
  region?: string;
  tenantTier?: string;
}

export function breakerKey(parts: BreakerKeyParts): string {
  return [
    parts.provider,
    parts.modelFamily,
    parts.region ?? 'default',
    parts.tenantTier ?? 'default',
  ].join('|');
}

export class CircuitBreakerRegistry {
  private cells: Map<string, BreakerCell> = new Map();

  constructor(private readonly cfg: BreakerConfig = DEFAULT_BREAKER) {}

  cell(parts: BreakerKeyParts): BreakerCell {
    const key = breakerKey(parts);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = new BreakerCell(key, this.cfg);
      this.cells.set(key, cell);
    }
    return cell;
  }

  /**
   * Wrap an op with breaker enforcement. Throws BreakerOpenError when open.
   *
   * Permanent client errors (4xx other than 429) are NOT counted as
   * failures: they reflect bad input, not provider health. Counting them
   * would let a poison-pill caller trip the breaker for everyone else.
   */
  async run<T>(parts: BreakerKeyParts, op: () => Promise<T>): Promise<T> {
    const cell = this.cell(parts);
    if (!cell.canPass()) {
      throw new BreakerOpenError(breakerKey(parts), cell.retryAfterMs());
    }
    try {
      const result = await op();
      cell.onResult(true);
      return result;
    } catch (err) {
      if (!isPermanentClientError(err)) {
        cell.onResult(false);
      } else {
        // Permanent client error doesn't reflect provider health.
        // Release the half-open reservation so the slot doesn't leak.
        cell.releaseReservation();
      }
      throw err;
    }
  }
}

function isPermanentClientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status =
    (err as { status?: number }).status ??
    (err as { statusCode?: number }).statusCode;
  if (typeof status !== 'number') return false;
  // 4xx except 429 (rate limits are transient health signals).
  return status >= 400 && status < 500 && status !== 429;
}
