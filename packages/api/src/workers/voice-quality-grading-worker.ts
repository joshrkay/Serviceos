/**
 * #1602 — nightly voice-quality grading sweep (P0-009 cross-tenant pattern).
 *
 * app.ts drives `handle()` on an interval behind the leader advisory lock
 * (SWEEP_LOCK.voiceQualityGrading); the nightly hour gate inside `handle()`
 * makes the pass run once a day without a cron. Per tenant, with the
 * tenant's `voice_quality_sample_rate_pct` / `voice_quality_daily_cap`
 * (tenant_settings, defaults 20% / 20):
 *
 *   1. candidates = ended `voice_inbound` calls in the look-back window that
 *      carried the recording disclosure, were billable (owner / test calls
 *      excluded by the `call_usage_events` rule) and have no grade yet;
 *   2. sample = max(1, ceil(candidates × rate)) of them, chosen at random,
 *      never more than what is left of today's cap;
 *   3. each sampled call goes through `gradeVoiceSession` (the service
 *      re-checks every gate — the store's candidate query is an
 *      optimisation, not the authority).
 *
 * Failure isolation at both levels: a throwing tenant is logged and skipped
 * (others still sweep); a failing call is counted and the siblings still
 * grade. The owner's on-demand trigger is `handle({ tenantId, trigger:
 * 'manual' })` — one tenant, right now, same cap.
 */
import type { VoiceSessionGrader } from '../voice/quality/grade-voice-session';
import type { VoiceGradeTrigger, VoiceSessionGradeStore } from '../voice/quality/voice-session-grade-store';

/** app.ts tick cadence; the nightly-hour gate makes this a once-a-day pass. */
export const VOICE_QUALITY_GRADING_INTERVAL_MS = 30 * 60 * 1000;
/** Default nightly hour (UTC) — 08:00Z is 1–4am across the US. */
export const DEFAULT_VOICE_QUALITY_NIGHTLY_HOUR_UTC = 8;
const DEFAULT_LOOKBACK_HOURS = 24;
/** Upper bound on candidates read per tenant per pass. */
const CANDIDATE_READ_LIMIT = 500;

interface GradingLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface VoiceQualityGradingWorkerDeps {
  store: VoiceSessionGradeStore;
  grader: VoiceSessionGrader;
  listTenantIds: () => Promise<string[]>;
  logger: GradingLogger;
  now?: () => Date;
  /** Injectable for deterministic sampling in tests. Default Math.random. */
  random?: () => number;
  lookbackHours?: number;
  /**
   * When set, a scheduled `handle()` only runs during this UTC hour (the
   * daily cap + already-graded filter make repeat ticks inside the hour
   * idempotent). Unset → every tick runs (tests, manual triggers).
   */
  nightlyHourUtc?: number;
}

export interface VoiceQualityGradingRunResult {
  /** False when the tick fell outside the nightly hour and did nothing. */
  ran: boolean;
  tenantsSwept: number;
  graded: number;
  /** Calls the service declined (gate) or that were already graded. */
  skipped: number;
  /** Calls whose grading threw (judge outage, store write) — logged, never rethrown. */
  failures: number;
}

export interface VoiceQualityGradingHandleOptions {
  trigger?: VoiceGradeTrigger;
  /** On-demand: sweep only this tenant, ignoring the nightly hour. */
  tenantId?: string;
}

export interface VoiceQualityGradingWorker {
  handle(opts?: VoiceQualityGradingHandleOptions): Promise<VoiceQualityGradingRunResult>;
}

export function createVoiceQualityGradingWorker(
  deps: VoiceQualityGradingWorkerDeps,
): VoiceQualityGradingWorker {
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const lookbackMs = (deps.lookbackHours ?? DEFAULT_LOOKBACK_HOURS) * 60 * 60 * 1000;

  async function sweepTenant(
    tenantId: string,
    at: Date,
    trigger: VoiceGradeTrigger,
    result: VoiceQualityGradingRunResult,
  ): Promise<void> {
    const quota = await deps.store.quota(tenantId);
    const gradedToday = await deps.store.countGradedSince(tenantId, startOfUtcDay(at));
    const remaining = Math.max(0, quota.dailyCap - gradedToday);
    if (remaining === 0) return;

    const candidates = await deps.store.listUngradedCandidates(tenantId, {
      endedSince: new Date(at.getTime() - lookbackMs),
      endedBefore: at,
      limit: CANDIDATE_READ_LIMIT,
    });
    if (candidates.length === 0) return;

    const target = Math.max(1, Math.ceil((candidates.length * quota.sampleRatePct) / 100));
    const sample = pickSample(candidates, Math.min(target, remaining), random);

    for (const sessionId of sample) {
      try {
        const outcome = await deps.grader.gradeVoiceSession(tenantId, sessionId, { trigger });
        if (outcome.status === 'graded') result.graded += 1;
        else result.skipped += 1;
      } catch (err) {
        result.failures += 1;
        deps.logger.warn('voice-quality-grading: call grading failed, skipping', {
          tenantId,
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async function handle(
    opts: VoiceQualityGradingHandleOptions = {},
  ): Promise<VoiceQualityGradingRunResult> {
    const at = now();
    const trigger: VoiceGradeTrigger = opts.trigger ?? (opts.tenantId ? 'manual' : 'nightly');
    const result: VoiceQualityGradingRunResult = {
      ran: false,
      tenantsSwept: 0,
      graded: 0,
      skipped: 0,
      failures: 0,
    };

    const scheduled = opts.tenantId === undefined;
    if (scheduled && deps.nightlyHourUtc !== undefined && at.getUTCHours() !== deps.nightlyHourUtc) {
      return result;
    }
    result.ran = true;

    const tenantIds = opts.tenantId ? [opts.tenantId] : await deps.listTenantIds();
    for (const tenantId of tenantIds) {
      try {
        result.tenantsSwept += 1;
        await sweepTenant(tenantId, at, trigger, result);
      } catch (err) {
        result.failures += 1;
        deps.logger.error('voice-quality-grading: tenant sweep failed, continuing', {
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (result.graded > 0 || result.failures > 0) {
      deps.logger.info('voice-quality-grading: pass complete', { ...result, trigger });
    }
    return result;
  }

  return { handle };
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Partial Fisher–Yates: the first `n` of a shuffle, without mutating the input. */
export function pickSample<T>(items: readonly T[], n: number, random: () => number): T[] {
  const pool = [...items];
  const count = Math.min(n, pool.length);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}
