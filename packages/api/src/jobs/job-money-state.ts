/**
 * §6 Time-to-Cash — the denormalized job money-state rollup.
 *
 * IMPORTANT: estimate/invoice/job modules are imported `import type` only
 * (erased at compile time). At this point in the plan (Task 2) the file
 * has ZERO value imports. Task 3 will add `refreshJobMoneyState` and the
 * ONE value import allowed here: `createAuditEvent` from audit/audit —
 * giving a runtime import graph of `estimate.ts -> job-money-state.ts ->
 * audit/audit`, with no cycle even though those modules later import
 * `refreshJobMoneyStateSafe` back from here.
 */
import type { Estimate, EstimateRepository } from '../estimates/estimate';
import type { Invoice, InvoiceRepository } from '../invoices/invoice';
import type { Job, JobMoneyState, JobRepository } from './job';
import type { Logger } from '../logging/logger';
import { type AuditRepository, createAuditEvent } from '../audit/audit';

/**
 * Pure precedence function: given all of a job's estimates and invoices,
 * return the single money-state that best describes it. Highest-priority
 * match wins:
 *
 *   overdue           — an unpaid invoice is past its due date
 *   invoiced          — an unpaid invoice exists (none overdue)
 *   paid              — every invoice that exists is fully paid
 *   estimate_accepted — the customer accepted an estimate
 *   estimate_sent     — an estimate was sent, not yet accepted
 *   no_estimate       — nothing above matched
 *
 * "Still owes money" (invoiced/overdue) outranks `paid` because a second
 * invoice or a partial payment means money is outstanding. Invoice states
 * outrank estimate states. Ignored: draft/void/canceled invoices and
 * draft/ready_for_review/rejected/expired estimates.
 */
export function computeJobMoneyState(
  estimates: readonly Estimate[],
  invoices: readonly Invoice[],
  now: Date,
): JobMoneyState {
  const unpaidInvoices = invoices.filter(
    (i) => i.status === 'open' || i.status === 'partially_paid',
  );

  const hasOverdue = unpaidInvoices.some(
    (i) => i.dueDate !== undefined && i.dueDate.getTime() < now.getTime(),
  );
  if (hasOverdue) return 'overdue';

  if (unpaidInvoices.length > 0) return 'invoiced';

  if (invoices.some((i) => i.status === 'paid')) return 'paid';

  if (estimates.some((e) => e.status === 'accepted')) return 'estimate_accepted';

  if (estimates.some((e) => e.status === 'sent')) return 'estimate_sent';

  return 'no_estimate';
}

export interface RefreshJobMoneyStateDeps {
  jobRepo: JobRepository;
  estimateRepo: EstimateRepository;
  invoiceRepo: InvoiceRepository;
  /** When provided, a `job.money_state_changed` event is emitted on every transition. */
  auditRepo?: AuditRepository;
  /**
   * Optional logger — when provided, `refreshJobMoneyStateSafe` will
   * `logger.warn(...)` on rollup failure instead of swallowing silently.
   * Domain functions don't have loggers; route and worker call sites
   * (Tasks 5–7) do and should supply one via `deps.logger`.
   */
  logger?: Logger;
}

export interface RefreshJobMoneyStateResult {
  job: Job | null;
  changed: boolean;
  previous: JobMoneyState;
  current: JobMoneyState;
}

/**
 * Recompute and persist a job's money-state from its current estimates
 * and invoices. No-ops (changed: false) when the recomputed state equals
 * the stored one. On a real transition it persists the new state and —
 * when `auditRepo` is wired — emits a `job.money_state_changed` event.
 *
 * Can throw (repo failures propagate). Route/webhook callers should use
 * `refreshJobMoneyStateSafe`.
 */
export async function refreshJobMoneyState(
  tenantId: string,
  jobId: string,
  actorId: string,
  deps: RefreshJobMoneyStateDeps,
): Promise<RefreshJobMoneyStateResult> {
  const job = await deps.jobRepo.findById(tenantId, jobId);
  if (!job) {
    return { job: null, changed: false, previous: 'no_estimate', current: 'no_estimate' };
  }

  const previous: JobMoneyState = job.moneyState ?? 'no_estimate';
  const [estimates, invoices] = await Promise.all([
    deps.estimateRepo.findByJob(tenantId, jobId),
    deps.invoiceRepo.findByJob(tenantId, jobId),
  ]);
  const current = computeJobMoneyState(estimates, invoices, new Date());

  if (current === previous) {
    return { job, changed: false, previous, current };
  }

  const updated = await deps.jobRepo.update(tenantId, jobId, {
    moneyState: current,
    updatedAt: new Date(),
  });
  if (!updated) {
    // Job was deleted between the findById above and this update — race
    // with a concurrent delete. Treat as a no-op (no audit event); the
    // caller sees `changed: false` consistent with `job: null`.
    return { job: null, changed: false, previous, current };
  }

  if (deps.auditRepo) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: 'system',
        eventType: 'job.money_state_changed',
        entityType: 'job',
        entityId: jobId,
        metadata: { from: previous, to: current },
      }),
    );
  }

  return { job: updated, changed: true, previous, current };
}

/**
 * Non-throwing wrapper for route/webhook/worker call sites: a money-state
 * rollup failure must never bounce the underlying mutation (the
 * estimate/invoice/payment write already succeeded). Logs and returns a
 * no-op result on any error.
 */
export async function refreshJobMoneyStateSafe(
  tenantId: string,
  jobId: string,
  actorId: string,
  deps: RefreshJobMoneyStateDeps,
  logger?: Logger,
): Promise<RefreshJobMoneyStateResult> {
  try {
    return await refreshJobMoneyState(tenantId, jobId, actorId, deps);
  } catch (err) {
    const effectiveLogger = logger ?? deps.logger;
    effectiveLogger?.warn('refreshJobMoneyState failed', {
      tenantId,
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { job: null, changed: false, previous: 'no_estimate', current: 'no_estimate' };
  }
}
