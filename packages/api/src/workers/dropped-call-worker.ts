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
 * terminally suppressed ('expired') in a dedicated reap pass (not sent or
 * skipped). Two guarantees: (1) enabling a tenant's flag more than this window
 * after a drop never blasts hours-old "we got cut off" texts; (2) the reap
 * drains any accumulated backlog OUTSIDE the send batch. Starvation of enabled
 * tenants by disabled tenants' backlog is prevented separately, by scoping the
 * send batch to the enabled-tenant allowlist (see the sweep's Phase 2).
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
   * Staleness cutoff relative to scheduled_for; stale rows are reaped
   * terminally as 'expired' (Phase 1) whatever the flag says.
   */
  maxAgeMs?: number;
  now?: () => Date;
  batchSize?: number;
}

export interface DroppedCallSweepResult {
  /** Fresh rows fetched into the send batch (enabled tenants only). */
  due: number;
  sent: number;
  suppressed: number;
  /** Flag-disabled tenants skipped this tick; their rows stay pending. */
  skipped: number;
  /** Rows past maxAgeMs, terminally suppressed as 'expired'. */
  expired: number;
  failed: number;
}

/**
 * Run one drain sweep. Returns counts for observability. Never throws — each
 * phase (stale reap, enabled-tenant send batch) is independently try/caught
 * and logged so the worker loop keeps running.
 */
export async function runDroppedCallRecoverySweep(
  deps: DroppedCallWorkerDeps,
): Promise<DroppedCallSweepResult> {
  const now = deps.now ?? (() => new Date());
  const batchSize = deps.batchSize ?? DROPPED_CALL_SWEEP_BATCH;
  const maxAgeMs = deps.maxAgeMs ?? DROPPED_CALL_MAX_AGE_MS;
  const fullDeps: DroppedCallHandlerDeps = { repo: deps.repo, ...deps.handlerDeps };
  // Snapshot the clock once so the stale/fresh boundary is judged against the
  // same instant that selects the batch (a per-row clock read would let a
  // row's due-vs-expired classification drift as the batch is processed).
  const sweepNow = now();
  const staleBefore = new Date(sweepNow.getTime() - maxAgeMs);

  let sent = 0;
  let suppressed = 0;
  let skipped = 0;
  let expired = 0;
  let failed = 0;

  // Phase 1 — reap stale rows (all tenants, regardless of flag). A recovery
  // text is only meaningful minutes after the drop; expiring stale rows
  // terminally keeps the pending set bounded. Critically, reaping them in a
  // dedicated pass means a large accumulated backlog (rows scheduled since the
  // scheduler was wired but never drained) is cleared OUTSIDE the send batch —
  // it can never occupy send-batch slots and delay live recoveries.
  try {
    const stale = await deps.repo.findExpired(staleBefore, batchSize);
    for (const row of stale) {
      try {
        await suppress(row, 'expired', fullDeps);
        expired++;
      } catch (err) {
        failed++;
        deps.logger.warn('dropped-call sweep: expire failed', {
          tenantId: row.tenantId,
          recoveryId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    deps.logger.error('dropped-call sweep: findExpired failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Phase 2 — send batch: FRESH due rows for ENABLED tenants only. Resolving
  // the enabled-tenant allowlist first and scoping the fetch to it means a
  // flag-disabled tenant's backlog is never fetched into the batch, so it
  // cannot fill the oldest-first LIMIT and starve an enabled tenant's recovery
  // (the batch contains only rows we will actually attempt to send). Disabled
  // tenants' rows stay pending — a brief kill-switch dip is reversible within
  // the freshness window; `skipped` counts flag-disabled tenants, not rows.
  let sendable: Awaited<ReturnType<DroppedCallRecoveryRepository['findDueForTenants']>> = [];
  try {
    const dueTenants = await deps.repo.findDueTenantIds(sweepNow, staleBefore);
    const enabled: string[] = [];
    for (const tenantId of dueTenants) {
      try {
        if (!deps.isEnabledForTenant || (await deps.isEnabledForTenant(tenantId))) {
          enabled.push(tenantId);
        } else {
          skipped++;
        }
      } catch (err) {
        // A flag-store error must not send to an unresolved tenant: treat as
        // skipped (row stays pending) and try again next tick.
        skipped++;
        deps.logger.warn('dropped-call sweep: flag check failed', {
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (enabled.length > 0) {
      sendable = await deps.repo.findDueForTenants(sweepNow, staleBefore, enabled, batchSize);
    }
  } catch (err) {
    deps.logger.error('dropped-call sweep: send-batch fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  for (const row of sendable) {
    try {
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
    due: sendable.length,
    sent,
    suppressed,
    skipped,
    expired,
    failed,
  });

  return { due: sendable.length, sent, suppressed, skipped, expired, failed };
}
