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

  const candidates: InvoicingCandidate[] = [];
  for (const job of jobs) {
    const moneyState = job.moneyState ?? 'no_estimate';
    if (!ELIGIBLE_MONEY_STATES.includes(moneyState)) continue;

    const invoices = await deps.invoiceRepo.findByJob(tenantId, job.id);
    if (hasLiveInvoice(invoices.map((i) => i.status))) continue;

    const estimates = await deps.estimateRepo.findByJob(tenantId, job.id);
    const accepted = estimates.find((e) => e.status === 'accepted');
    const lineItems = accepted
      ? resolveSelectedLineItems(accepted.lineItems, accepted.acceptedSelection)
      : [];
    if (lineItems.length === 0) continue;

    candidates.push({
      jobId: job.id,
      customerId: job.customerId,
      estimateId: accepted?.id,
      lineItems,
      amountCents: calculateDocumentTotals(lineItems, 0, 0).totalCents,
    });
  }

  return candidates;
}
