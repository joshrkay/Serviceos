/**
 * Technician profitability (P&L) rollup — Jobber-parity reporting.
 *
 * "How much money has this technician brought in?" = the per-job profit
 * aggregated across the jobs assigned to them (job.assignedTechnicianId, the
 * denormalized primary tech). Selection (findByTenant with a technicianId
 * filter) is all this adds; the rollup math is shared with the customer report
 * via job-profit-rollup.ts.
 *
 * Attribution note: a job's full revenue/cost is credited to its assigned
 * technician (the same single-owner model the customer report uses). Jobs with
 * no assigned technician are simply not part of any technician's rollup.
 */
import type { JobRepository } from '../jobs/job';
import type { GetJobProfitDeps } from '../jobs/job-profit';
import { aggregateJobProfits, type JobProfitRollup } from './job-profit-rollup';

export interface TechnicianProfit extends JobProfitRollup {
  technicianId: string;
}

export interface GetTechnicianProfitInput {
  tenantId: string;
  technicianId: string;
  /** Tenant labor rate (integer cents/hour). Null/undefined ⇒ labor unpriced. */
  laborRateCentsPerHour?: number | null;
}

export interface GetTechnicianProfitDeps extends GetJobProfitDeps {
  /** findByTenant is a required method on JobRepository (no narrowing needed). */
  jobRepo: Pick<JobRepository, 'findByTenant'>;
}

export async function getTechnicianProfit(
  input: GetTechnicianProfitInput,
  deps: GetTechnicianProfitDeps,
): Promise<TechnicianProfit> {
  // includeArchived so a completed (non-canceled) job still counts — the
  // default findByTenant filter already excludes archived/canceled noise.
  const jobs = await deps.jobRepo.findByTenant(input.tenantId, {
    technicianId: input.technicianId,
  });
  const rollup = await aggregateJobProfits(jobs, input, deps);
  return { technicianId: input.technicianId, ...rollup };
}
