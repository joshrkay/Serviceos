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
import type { Estimate } from '../estimates/estimate';
import type { Invoice } from '../invoices/invoice';
import type { JobMoneyState } from './job';

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
