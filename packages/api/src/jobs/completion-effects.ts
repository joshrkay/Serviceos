/**
 * Shared job-completion side effects (Time-to-Cash).
 *
 * The (… → completed) transition fires irreversible, money-touching effects:
 *   1. auto-draft an invoice proposal (P20-001, opt-in, gated inside)
 *   2. mint on_completion schedule milestones (P21, opt-in, gated inside)
 * (The 24h thank-you / review-request asks are driven off `completedAt` by
 *  the leader-locked sweeps — no per-transition work here.)
 *
 * This lives in one place so BOTH callers run identical logic:
 *   - the authenticated route (POST /api/jobs/:id/transition, routes/jobs.ts)
 *   - the voice/assistant execution path (UpdateJobExecutionHandler)
 * Previously only the route ran these effects, so a voice-approved
 * "mark the job completed" invoiced nothing and minted no milestones.
 *
 * Both effects are best-effort and idempotent: a failure here must NEVER fail
 * the completion the operator/owner already approved (the money-state is
 * reconciled by the sweeps / next mutation). Each is logged loudly on failure.
 */
import { Job } from './job';
import {
  maybeAutoInvoiceOnCompletion,
  AutoInvoiceOnCompletionDeps,
} from '../invoices/auto-invoice-on-completion';
import { mintCompletionMilestones } from '../invoices/schedule-completion';
import { InvoiceScheduleRepository } from '../invoices/invoice-schedule';

/**
 * Everything the completion effects need. Superset of the auto-invoice deps
 * plus the optional `scheduleRepo` that gates milestone minting. When
 * `scheduleRepo` is absent, milestone minting is skipped (auto-invoice still
 * runs) — matching the route's `if (autoInvoiceDeps?.scheduleRepo)` guard.
 */
export type JobCompletionEffectsDeps = AutoInvoiceOnCompletionDeps & {
  scheduleRepo?: InvoiceScheduleRepository;
};

/** Minimal logger surface — the app Logger and console both satisfy it. */
export interface CompletionEffectsLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Run the completion side effects for a job that has just entered `completed`.
 * Callers must only invoke this AFTER the status transition has committed.
 */
export async function runJobCompletionEffects(
  deps: JobCompletionEffectsDeps,
  job: Job,
  logger: CompletionEffectsLogger,
): Promise<void> {
  // P20-001 — auto-draft an invoice (opt-in, gated inside). Best-effort: a
  // drafting failure must never fail the completion the owner just made.
  try {
    await maybeAutoInvoiceOnCompletion(deps, job);
  } catch (autoErr) {
    logger.error('auto-invoice on completion failed', {
      tenantId: job.tenantId,
      jobId: job.id,
      error: autoErr instanceof Error ? autoErr.message : String(autoErr),
    });
  }

  // P21 — mint on_completion milestones for any invoice schedule on this job
  // (e.g. the balance of a deposit/balance plan). Best-effort, same as above;
  // an approved schedule needs no re-approval to bill its plan.
  if (deps.scheduleRepo) {
    try {
      await mintCompletionMilestones(
        {
          scheduleRepo: deps.scheduleRepo,
          invoiceRepo: deps.invoiceRepo,
          settingsRepo: deps.settingsRepo,
          auditRepo: deps.auditRepo,
        },
        job,
      );
    } catch (milestoneErr) {
      logger.error('schedule completion milestone minting failed', {
        tenantId: job.tenantId,
        jobId: job.id,
        error: milestoneErr instanceof Error ? milestoneErr.message : String(milestoneErr),
      });
    }
  }
}
