/**
 * Customer profitability (P&L) rollup — Jobber-parity reporting.
 *
 * "How much money has this customer made me?" = the per-job profit aggregated
 * across every job the customer owns. Selection (findByCustomer) is all this
 * adds; the rollup math lives in job-profit-rollup.ts so the customer and
 * technician reports share one implementation.
 */
import type { JobRepository } from '../jobs/job';
import type { GetJobProfitDeps } from '../jobs/job-profit';
import {
  aggregateJobProfits,
  type JobProfitRollup,
} from './job-profit-rollup';

export interface CustomerProfit extends JobProfitRollup {
  customerId: string;
}

export interface GetCustomerProfitInput {
  tenantId: string;
  customerId: string;
  /** Tenant labor rate (integer cents/hour). Null/undefined ⇒ labor unpriced. */
  laborRateCentsPerHour?: number | null;
}

export interface GetCustomerProfitDeps extends GetJobProfitDeps {
  /** findByCustomer is required here (it is optional on the wider interface). */
  jobRepo: Required<Pick<JobRepository, 'findByCustomer'>>;
}

export async function getCustomerProfit(
  input: GetCustomerProfitInput,
  deps: GetCustomerProfitDeps,
): Promise<CustomerProfit> {
  const jobs = await deps.jobRepo.findByCustomer(input.tenantId, input.customerId);
  const rollup = await aggregateJobProfits(jobs, input, deps);
  return { customerId: input.customerId, ...rollup };
}
