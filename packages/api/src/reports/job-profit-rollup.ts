/**
 * Shared job-profit aggregation — the common core behind the customer and
 * technician profitability reports. Both answer "what did this set of jobs earn
 * me?"; they differ only in HOW the job set is selected (by customer vs by
 * assigned technician). This module owns the rollup so that selection is the
 * only thing each report adds.
 *
 * Reuses getJobProfit verbatim (src/jobs/job-profit.ts) so the
 * revenue/labor/materials/expense definitions stay identical to the per-job
 * report — one source of truth. Integer cents end-to-end. Labor honesty carries
 * up: when ANY job's labor is unpriced (no tenant labor rate) `laborUnpriced`
 * is true and that job's labor counts as 0 in the totals.
 */
import type { Job } from '../jobs/job';
import {
  getJobProfit,
  computeMarginPct,
  type GetJobProfitDeps,
  type JobProfit,
} from '../jobs/job-profit';

export interface JobProfitLine extends JobProfit {
  jobId: string;
  jobNumber: string;
  summary: string;
}

export interface JobProfitRollup {
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
  /** Per-job breakdown, in the order the job set was returned. */
  jobs: JobProfitLine[];
}

export interface AggregateJobProfitsInput {
  tenantId: string;
  /** Tenant labor rate (integer cents/hour). Null/undefined ⇒ labor unpriced. */
  laborRateCentsPerHour?: number | null;
}

export async function aggregateJobProfits(
  jobs: Job[],
  input: AggregateJobProfitsInput,
  deps: GetJobProfitDeps,
): Promise<JobProfitRollup> {
  const perJob = await Promise.all(
    jobs.map(async (job): Promise<JobProfitLine> => {
      const profit = await getJobProfit(
        { tenantId: input.tenantId, jobId: job.id, laborRateCentsPerHour: input.laborRateCentsPerHour },
        deps,
      );
      return { ...profit, jobId: job.id, jobNumber: job.jobNumber, summary: job.summary };
    }),
  );

  const sum = (pick: (j: JobProfitLine) => number) => perJob.reduce((s, j) => s + pick(j), 0);
  const revenueCents = sum((j) => j.revenueCents);
  const marginCents = sum((j) => j.marginCents);

  return {
    jobCount: perJob.length,
    revenueCents,
    laborCents: sum((j) => j.laborCents ?? 0),
    materialsCents: sum((j) => j.materialsCents),
    expensesCents: sum((j) => j.expensesCents),
    marginCents,
    marginPct: computeMarginPct(marginCents, revenueCents),
    laborUnpriced: perJob.some((j) => j.laborUnpriced),
    jobs: perJob,
  };
}
