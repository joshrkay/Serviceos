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
  type DroppedCallHandlerDeps,
} from '../sms/recovery/dropped-call-handler';
import type { DroppedCallRecoveryRepository } from '../sms/recovery/scheduler';

/** Default rows drained per sweep — bounds the batch under a backlog. */
export const DROPPED_CALL_SWEEP_BATCH = 100;

export interface DroppedCallWorkerDeps {
  repo: DroppedCallRecoveryRepository;
  /**
   * Per-row orchestrator dependencies (audit, rate-limit, compose, send,
   * thread, …). The worker forwards these unchanged to the handler.
   */
  handlerDeps: Omit<DroppedCallHandlerDeps, 'repo'>;
  logger: Logger;
  now?: () => Date;
  batchSize?: number;
}

export interface DroppedCallSweepResult {
  due: number;
  sent: number;
  suppressed: number;
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

  let due: Awaited<ReturnType<DroppedCallRecoveryRepository['findDue']>>;
  try {
    due = await deps.repo.findDue(now(), batchSize);
  } catch (err) {
    deps.logger.error('dropped-call sweep: findDue failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { due: 0, sent: 0, suppressed: 0, failed: 0 };
  }

  let sent = 0;
  let suppressed = 0;
  let failed = 0;

  for (const row of due) {
    try {
      const disposition = await handleDroppedCallRecovery(row, {
        repo: deps.repo,
        ...deps.handlerDeps,
      });
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
    failed,
  });

  return { due: due.length, sent, suppressed, failed };
}
