/**
 * Customer profitability (P&L) rollup — Jobber-parity reporting.
 *
 * Answers "How much money has this customer made me?" by aggregating the
 * per-job profit (src/jobs/job-profit.ts) across every job the customer owns:
 *
 *   margin = Σ(job revenue − job labor − job materials − job expenses)
 *
 * Pure aside from the repos it is handed; reuses getJobProfit verbatim so the
 * revenue/labor/materials/expense definitions stay identical to the per-job
 * report (no second source of truth for "what a job brought in"). Integer cents
 * end-to-end; every read is tenant-scoped.
 *
 * Labor honesty carries up: when ANY job's labor is unpriced (no tenant labor
 * rate), `laborUnpriced` is true and that job's labor counts as 0 in the
 * totals — the caller surfaces the same caveat the per-job report does.
 */
import type { JobRepository } from '../jobs/job';
import {
  getJobProfit,
  computeMarginPct,
  type GetJobProfitDeps,
  type JobProfit,
} from '../jobs/job-profit';

export interface CustomerJobProfit extends JobProfit {
  jobId: string;
  jobNumber: string;
  summary: string;
}

export interface CustomerProfit {
  customerId: string;
  jobCount: number;
  revenueCents: number;
  /** Σ of each job's priced labor (unpriced jobs contribute 0). */
  laborCents: number;
  materialsCents: number;
  expensesCents: number;
  /** revenue − labor − materials − expenses, summed across jobs. */
  marginCents: number;
  /** marginCents ÷ revenueCents (one decimal); null when revenue is 0. */
  marginPct: number | null;
  /** True when at least one job's labor was unpriced (margin excludes it). */
  laborUnpriced: boolean;
  /** Per-job breakdown, newest job first (findByCustomer order). */
  jobs: CustomerJobProfit[];
}

export interface GetCustomerProfitInput {
  tenantId: string;
  customerId: string;
  /** Tenant labor rate (integer cents/hour). Null/undefined ⇒ labor unpriced. */
  laborRateCentsPerHour?: number | null;
}

export interface GetCustomerProfitDeps extends GetJobProfitDeps {
  /** findByCustomer is required here (it is optional on the wider interface). */
  jobRepo: Pick<JobRepository, 'findByCustomer'> &
    Required<Pick<JobRepository, 'findByCustomer'>>;
}

export async function getCustomerProfit(
  input: GetCustomerProfitInput,
  deps: GetCustomerProfitDeps,
): Promise<CustomerProfit> {
  const { tenantId, customerId } = input;
  const jobs = await deps.jobRepo.findByCustomer(tenantId, customerId);

  const perJob = await Promise.all(
    jobs.map(async (job): Promise<CustomerJobProfit> => {
      const profit = await getJobProfit(
        { tenantId, jobId: job.id, laborRateCentsPerHour: input.laborRateCentsPerHour },
        deps,
      );
      return { ...profit, jobId: job.id, jobNumber: job.jobNumber, summary: job.summary };
    }),
  );

  const revenueCents = perJob.reduce((s, j) => s + j.revenueCents, 0);
  const laborCents = perJob.reduce((s, j) => s + (j.laborCents ?? 0), 0);
  const materialsCents = perJob.reduce((s, j) => s + j.materialsCents, 0);
  const expensesCents = perJob.reduce((s, j) => s + j.expensesCents, 0);
  const marginCents = perJob.reduce((s, j) => s + j.marginCents, 0);

  return {
    customerId,
    jobCount: perJob.length,
    revenueCents,
    laborCents,
    materialsCents,
    expensesCents,
    marginCents,
    marginPct: computeMarginPct(marginCents, revenueCents),
    laborUnpriced: perJob.some((j) => j.laborUnpriced),
    jobs: perJob,
  };
}
