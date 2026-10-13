/**
 * Post-job review-request sweeper (PRD US-345).
 *
 * Mirrors the thank-you-SMS sweep (thank-you-sms-worker.ts) but fires 24h
 * (not 2h) after completion and, instead of sending an SMS directly,
 * re-uses the existing gated review/feedback delivery by enqueuing the
 * `feedback_send` worker — which applies the consent + DNC gate, mints the
 * feedback request, and sends the link (4★+ customers are shown the tenant's
 * configured Google/Yelp review URL).
 *
 * For each tenant with `tenant_settings.send_review_request = TRUE`, the sweep
 * finds jobs that:
 *   1. Have a completion timestamp (completed_at IS NOT NULL),
 *   2. Are at least `delayHours` past completion (default 24) and at most
 *      REVIEW_REQUEST_MAX_AGE_DAYS (the recency floor),
 *   3. Have not already had a review request handled
 *      (review_request_sent_at IS NULL).
 *
 * For each it stamps `review_request_sent_at = NOW()` and then enqueues
 * `feedback_send` with the SAME idempotency key the old
 * immediate-on-completion enqueue used (`<tenant>:<job>:feedback_send`) so the
 * PgQueue's UNIQUE(idempotency_key) dedup collapses any overlap (a failed
 * enqueue clears the stamp again) — the stamp is the sweep's idempotency gate,
 * set whether feedback_send ultimately sends or suppresses (no phone / DNC /
 * no consent), so the sweep never re-checks the row.
 *
 * Recipient quiet hours make this sweep the review request's retry loop: a
 * tenant whose send window is closed is skipped (left eligible), and when the
 * recipient's own window is closed feedback_send clears the stamp again
 * without minting anything, so a later in-window tick re-enqueues the job.
 *
 * Sweep cadence is owned by app.ts (a leader-locked setInterval driver). Tests
 * exercise this function directly with in-memory repos + a fixed clock; an
 * integration test pins the eligibility query against real Postgres.
 *
 * Why not Inngest: the codebase uses db-backed durable queues + cross-tenant
 * sweeps (P0-009), same idiom as the thank-you / appointment-reminder /
 * overdue-invoice workers.
 */
import { Pool } from 'pg';
import { Logger } from '../logging/logger';
import { JobRepository } from '../jobs/job';
import { Queue } from '../queues/queue';
import type { GatedMessageDelivery } from '../notifications/gated-message-delivery';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Recency floor: no review ask for a job completed more than this many days
 * ago — after the toggle is switched back on, or a sweep outage, asking about
 * a visit from weeks back is a stale solicitation. Such jobs fall outside the
 * eligibility query, exactly like an opted-out tenant's: never selected, so
 * never stamped and never re-evaluated.
 *
 * The normal ask goes at 24 h and a quiet-hours hold lasts at most ~18 h (the
 * job simply stays eligible meanwhile), so a deferral never ages a job out.
 */
export const REVIEW_REQUEST_MAX_AGE_DAYS = 7;

export interface ReviewRequestWorkerDeps {
  /** Source of truth for the eligibility query (jobs ⋈ tenant_settings). */
  pool: Pool | null;
  jobRepo: JobRepository;
  /** Enqueues `feedback_send` (the existing gated review/feedback delivery). */
  queue: Pick<Queue, 'send'>;
  logger: Logger;
  /** Injectable clock — defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Delay between job.completed_at and the review request. Default 24 hours
   * per PRD US-345. Configurable so tests fire against recently-completed jobs.
   */
  delayHours?: number;
  /**
   * The gate's send-window verdict. A tenant whose window is closed (its zone,
   * strictest close) has its jobs left eligible for a later tick instead of
   * being enqueued only to be handed back by feedback_send. Absent → no check.
   */
  sendWindow?: Pick<GatedMessageDelivery, 'sendWindowVerdict'>;
}

export interface ReviewRequestSweepResult {
  /** Jobs that crossed the eligibility threshold this sweep. */
  candidates: number;
  /** feedback_send messages enqueued (and rows stamped). */
  enqueued: number;
  /** Per-job failures that left review_request_sent_at null for retry. */
  failed: number;
  /** Left for a later tick: the tenant's send window is closed. */
  deferred: number;
}

/**
 * Eligibility query — single SQL joining jobs to tenant_settings so a tenant
 * toggle change takes effect immediately. Mirrors the partial index from
 * migration 214.
 */
const ELIGIBLE_SQL = `
  SELECT j.id, j.tenant_id
    FROM jobs j
    JOIN tenant_settings ts ON ts.tenant_id = j.tenant_id
   WHERE ts.send_review_request = TRUE
     AND j.completed_at IS NOT NULL
     AND j.review_request_sent_at IS NULL
     AND j.completed_at <= $1
     AND j.completed_at >= $2
   ORDER BY j.completed_at ASC
   LIMIT 500
`;

interface EligibleRow {
  id: string;
  tenant_id: string;
}

export async function runReviewRequestSweep(
  deps: ReviewRequestWorkerDeps,
): Promise<ReviewRequestSweepResult> {
  const now = deps.now ?? (() => new Date());
  const delayHours = deps.delayHours ?? 24;
  const result: ReviewRequestSweepResult = { candidates: 0, enqueued: 0, failed: 0, deferred: 0 };

  if (!deps.pool) {
    // Mirror the no-DB-no-op posture of the other sweeps.
    return result;
  }

  const asOf = now();
  const completedBefore = new Date(asOf.getTime() - delayHours * HOUR_MS);
  const completedAfter = new Date(asOf.getTime() - REVIEW_REQUEST_MAX_AGE_DAYS * 24 * HOUR_MS);

  let rows: EligibleRow[];
  try {
    const queryResult = await deps.pool.query<EligibleRow>(ELIGIBLE_SQL, [completedBefore, completedAfter]);
    rows = queryResult.rows;
  } catch (err) {
    deps.logger.error('Review-request sweep: eligibility query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  result.candidates = rows.length;

  const windowOpen = new Map<string, boolean>();
  for (const row of rows) {
    try {
      if (deps.sendWindow) {
        let open = windowOpen.get(row.tenant_id);
        if (open === undefined) {
          open = (await deps.sendWindow.sendWindowVerdict({ tenantId: row.tenant_id })).isAllowedNow;
          windowOpen.set(row.tenant_id, open);
        }
        if (!open) {
          result.deferred++;
          continue;
        }
      }
      // Stamp regardless of whether feedback_send sends or suppresses, so the
      // sweep doesn't re-evaluate this job forever — and BEFORE enqueueing:
      // feedback_send clears the stamp to hand a quiet-hours deferral back,
      // and a fast worker's clear must land after this write, never under it.
      await deps.jobRepo.update(row.tenant_id, row.id, { reviewRequestSentAt: now() });
      try {
        await deps.queue.send(
          'feedback_send',
          { tenantId: row.tenant_id, jobId: row.id },
          `${row.tenant_id}:${row.id}:feedback_send`,
        );
      } catch (err) {
        // Nothing was enqueued: clear the stamp so the next sweep retries.
        await deps.jobRepo.update(row.tenant_id, row.id, { reviewRequestSentAt: undefined });
        throw err;
      }
      result.enqueued++;
    } catch (err) {
      // Transient: leave review_request_sent_at null so the next sweep retries.
      result.failed++;
      deps.logger.warn('Review-request sweep: enqueue failed for job', {
        tenantId: row.tenant_id,
        jobId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deps.logger.info('Review-request sweep completed', {
    candidates: result.candidates,
    enqueued: result.enqueued,
    failed: result.failed,
    deferred: result.deferred,
  });

  return result;
}
