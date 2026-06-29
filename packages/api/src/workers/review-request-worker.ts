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
 *   2. Are at least `delayHours` past completion (default 24),
 *   3. Have not already had a review request handled
 *      (review_request_sent_at IS NULL).
 *
 * For each it enqueues `feedback_send` with the SAME idempotency key the old
 * immediate-on-completion enqueue used (`<tenant>:<job>:feedback_send`) so the
 * PgQueue's UNIQUE(idempotency_key) dedup collapses any overlap, then stamps
 * `review_request_sent_at = NOW()` — the stamp is the sweep's idempotency gate,
 * set whether feedback_send ultimately sends or suppresses (no phone / DNC /
 * no consent), so the sweep never re-checks the row.
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

const HOUR_MS = 60 * 60 * 1000;

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
}

export interface ReviewRequestSweepResult {
  /** Jobs that crossed the eligibility threshold this sweep. */
  candidates: number;
  /** feedback_send messages enqueued (and rows stamped). */
  enqueued: number;
  /** Per-job failures that left review_request_sent_at null for retry. */
  failed: number;
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
  const result: ReviewRequestSweepResult = { candidates: 0, enqueued: 0, failed: 0 };

  if (!deps.pool) {
    // Mirror the no-DB-no-op posture of the other sweeps.
    return result;
  }

  const completedBefore = new Date(now().getTime() - delayHours * HOUR_MS);

  let rows: EligibleRow[];
  try {
    const queryResult = await deps.pool.query<EligibleRow>(ELIGIBLE_SQL, [completedBefore]);
    rows = queryResult.rows;
  } catch (err) {
    deps.logger.error('Review-request sweep: eligibility query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  result.candidates = rows.length;

  for (const row of rows) {
    try {
      await deps.queue.send(
        'feedback_send',
        { tenantId: row.tenant_id, jobId: row.id },
        `${row.tenant_id}:${row.id}:feedback_send`,
      );
      // Stamp regardless of whether feedback_send sends or suppresses, so the
      // sweep doesn't re-evaluate this job forever.
      await deps.jobRepo.update(row.tenant_id, row.id, { reviewRequestSentAt: now() });
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
  });

  return result;
}
