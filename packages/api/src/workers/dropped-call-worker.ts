/**
 * P8-015 — Dropped-call recovery worker.
 *
 * Drains the durable `dropped_call_recoveries` queue: finds rows whose
 * `scheduled_for` is due and that are neither sent nor suppressed, and runs
 * each through the orchestrator (`handleDroppedCallRecovery`). Because the
 * queue is a Postgres table (not an in-process timer), a server restart
 * between schedule (T=0) and send (T=60s) never loses a recovery — the next
 * sweep picks it up. This is the same durable-schedule pattern used by the
 * appointment-reminder and agreement-run sweeps.
 *
 * Per-row failures are isolated: one row that throws (compose/send error) is
 * logged and left pending (not stamped) so the next sweep retries it, while
 * the rest of the batch still drains. Business suppressions are NOT failures —
 * the orchestrator stamps them and returns normally.
 */
import type { Logger } from '../logging/logger';
import {
  DEFAULT_SYSTEM_ACTOR,
  handleDroppedCallRecovery,
  suppress,
  type DroppedCallHandlerDeps,
} from '../sms/recovery/dropped-call-handler';
import type { DroppedCallRecoveryRepository } from '../sms/recovery/scheduler';

/** Default rows drained per sweep — bounds the batch under a backlog. */
export const DROPPED_CALL_SWEEP_BATCH = 100;

/**
 * Per-tenant rollout / kill-switch flag key. Resolved through
 * PgTenantFeatureFlagRepository.isEnabledForTenant (tenant override →
 * platform flag → false), so the feature is dark by default and instantly
 * disable-able per tenant.
 */
export const DROPPED_CALL_RECOVERY_FLAG = 'dropped_call_recovery';

/**
 * Default staleness cutoff: rows whose scheduled_for is older than this are
 * terminally suppressed ('expired') instead of sent or skipped. This is what
 * makes the flag gate's skip-not-suppress semantics safe — without it,
 * >batch-size pending rows for disabled tenants would starve enabled tenants
 * (findDue is oldest-first), and flipping a flag on would blast hours-old
 * "we got cut off" texts.
 */
export const DROPPED_CALL_MAX_AGE_MS = 30 * 60_000;

export interface DroppedCallWorkerDeps {
  repo: DroppedCallRecoveryRepository;
  /**
   * Per-row orchestrator dependencies (audit, rate-limit, compose, send,
   * thread, …). The worker forwards these unchanged to the handler.
   */
  handlerDeps: Omit<DroppedCallHandlerDeps, 'repo'>;
  logger: Logger;
  /**
   * Per-tenant flag gate. Rows for disabled tenants are SKIPPED (left
   * pending — a brief kill-switch dip stays reversible within the maxAgeMs
   * freshness window). Absent → every row is processed.
   */
  isEnabledForTenant?: (tenantId: string) => Promise<boolean>;
  /**
   * Staleness cutoff relative to scheduled_for; checked BEFORE the flag
   * gate so stale rows expire terminally whatever the flag says.
   */
  maxAgeMs?: number;
  now?: () => Date;
  batchSize?: number;
}

export interface DroppedCallSweepResult {
  due: number;
  sent: number;
  suppressed: number;
  /** Rows for flag-disabled tenants, left pending (reversible). */
  skipped: number;
  /** Rows past maxAgeMs, terminally suppressed as 'expired'. */
  expired: number;
  failed: number;
}

/**
 * Run one drain sweep. Returns counts for observability. Never throws — a
 * top-level failure (e.g. the `findDue` query) is logged and returns zeroed
 * counts so the worker loop keeps running.
 */
export async function runDroppedCallRecoverySweep(
  deps: DroppedCallWorkerDeps,
): Promise<DroppedCallSweepResult> {
  const now = deps.now ?? (() => new Date());
  const batchSize = deps.batchSize ?? DROPPED_CALL_SWEEP_BATCH;
  const maxAgeMs = deps.maxAgeMs ?? DROPPED_CALL_MAX_AGE_MS;
  const fullDeps: DroppedCallHandlerDeps = { repo: deps.repo, ...deps.handlerDeps };
  const actorId = deps.handlerDeps.systemActorId ?? DEFAULT_SYSTEM_ACTOR;

  let due: Awaited<ReturnType<DroppedCallRecoveryRepository['findDue']>>;
  try {
    due = await deps.repo.findDue(now(), batchSize);
  } catch (err) {
    deps.logger.error('dropped-call sweep: findDue failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { due: 0, sent: 0, suppressed: 0, skipped: 0, expired: 0, failed: 0 };
  }

  let sent = 0;
  let suppressed = 0;
  let skipped = 0;
  let expired = 0;
  let failed = 0;

  for (const row of due) {
    try {
      // Staleness expiry FIRST (whatever the flag says): a recovery text is
      // only meaningful minutes after the drop; expiring keeps the pending
      // set bounded so skipped rows can never starve the oldest-first batch.
      if (now().getTime() - row.scheduledFor.getTime() > maxAgeMs) {
        await suppress(row, 'expired', fullDeps, actorId);
        expired++;
        continue;
      }

      // Per-tenant flag gate: skip (leave pending) so a brief kill-switch
      // dip is reversible within the freshness window above.
      if (deps.isEnabledForTenant && !(await deps.isEnabledForTenant(row.tenantId))) {
        skipped++;
        continue;
      }

      const disposition = await handleDroppedCallRecovery(row, fullDeps);
      if (disposition.action === 'sent') sent++;
      else suppressed++;
    } catch (err) {
      // Leave the row pending so the next sweep retries it.
      failed++;
      deps.logger.warn('dropped-call sweep: row failed', {
        tenantId: row.tenantId,
        voiceSessionId: row.voiceSessionId,
        recoveryId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deps.logger.info('dropped-call sweep completed', {
    due: due.length,
    sent,
    suppressed,
    skipped,
    expired,
    failed,
  });

  return { due: due.length, sent, suppressed, skipped, expired, failed };
}
