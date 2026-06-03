/**
 * P21-003 — "Requires invoicing" queue.
 *
 * Finds completed jobs that should be invoiced but haven't been: status
 * `completed`, money-state `estimate_accepted` | `no_estimate`, no live
 * invoice yet, and something billable on the accepted estimate. The batch
 * sweep turns these into one `batch_invoice` proposal; a thin web list reads
 * the same query. Pure over its repos — no side effects.
 */
import { JobRepository, JobMoneyState } from '../jobs/job';
import { InvoiceRepository } from './invoice';
import { EstimateRepository } from '../estimates/estimate';
import {
  LineItem,
  calculateDocumentTotals,
  resolveSelectedLineItems,
} from '../shared/billing-engine';

const ELIGIBLE_MONEY_STATES: JobMoneyState[] = ['estimate_accepted', 'no_estimate'];
const MAX_CANDIDATES = 200;

/** One job that needs invoicing, with its resolved billable line items. */
export interface InvoicingCandidate {
  jobId: string;
  customerId: string;
  estimateId?: string;
  lineItems: LineItem[];
  /** Carried from the accepted estimate so the billed amount matches it. */
  discountCents: number;
  taxRateBps: number;
  amountCents: number;
}

export interface InvoicingQueueDeps {
  jobRepo: JobRepository;
  invoiceRepo: InvoiceRepository;
  estimateRepo: EstimateRepository;
}

function hasLiveInvoice(statuses: string[]): boolean {
  return statuses.some((s) => s !== 'void' && s !== 'canceled');
}

/** Group rows by a key into a Map, preserving insertion order within a key. */
function groupBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const arr = out.get(key);
    if (arr) arr.push(row);
    else out.set(key, [row]);
  }
  return out;
}

/**
 * Returns the jobs requiring invoicing for a tenant. Excludes jobs that
 * already have a live (non-void/canceled) invoice and jobs with nothing to
 * bill, so the same job is never surfaced twice once invoiced.
 */
export async function findJobsRequiringInvoicing(
  tenantId: string,
  deps: InvoicingQueueDeps,
): Promise<InvoicingCandidate[]> {
  const jobs = await deps.jobRepo.findByTenant(tenantId, {
    status: 'completed',
    limit: MAX_CANDIDATES,
  });

  // Narrow to billable money-states first so we only fetch invoices/estimates
  // for jobs that could actually be invoiced.
  const eligible = jobs.filter((j) =>
    ELIGIBLE_MONEY_STATES.includes(j.moneyState ?? 'no_estimate'),
  );
  if (eligible.length === 0) return [];
  const jobIds = eligible.map((j) => j.id);

  // Batch the per-job lookups: TWO queries total instead of 2N. This path runs
  // in the cross-tenant batch sweep AND backs a user-facing "requires
  // invoicing" list, so the prior findByJob-per-job loop was a real N+1.
  const [allInvoices, allEstimates] = await Promise.all([
    deps.invoiceRepo.findByJobs(tenantId, jobIds),
    deps.estimateRepo.findByJobs(tenantId, jobIds),
  ]);
  const invoicesByJob = groupBy(allInvoices, (i) => i.jobId);
  const estimatesByJob = groupBy(allEstimates, (e) => e.jobId);

  const candidates: InvoicingCandidate[] = [];
  for (const job of eligible) {
    const invoices = invoicesByJob.get(job.id) ?? [];
    if (hasLiveInvoice(invoices.map((i) => i.status))) continue;

    const estimates = estimatesByJob.get(job.id) ?? [];
    const accepted = estimates.find((e) => e.status === 'accepted');
    const lineItems = accepted
      ? resolveSelectedLineItems(accepted.lineItems, accepted.acceptedSelection)
      : [];
    if (lineItems.length === 0) continue;

    // Carry the accepted estimate's discount + tax so the batch summary total
    // and the fanned-out draft invoices match what the customer accepted.
    const discountCents = accepted?.totals.discountCents ?? 0;
    const taxRateBps = accepted?.totals.taxRateBps ?? 0;

    candidates.push({
      jobId: job.id,
      customerId: job.customerId,
      estimateId: accepted?.id,
      lineItems,
      discountCents,
      taxRateBps,
      amountCents: calculateDocumentTotals(lineItems, discountCents, taxRateBps).totalCents,
    });
  }

  return candidates;
}
