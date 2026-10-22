import type { Job, JobFindByCustomerOptions, JobRepository } from '../../jobs/job';

/**
 * The jobs a customer-scoped lookup reads. With `jobId` (the job the operator
 * pointed at), only that job, read directly: the customer's job list is
 * capped at MAX_JOB_LIMIT and may leave it out. A job that is not this
 * customer's yields none.
 */
export async function customerJobsForLookup(
  jobRepo: Pick<JobRepository, 'findById' | 'findByCustomer'>,
  tenantId: string,
  customerId: string,
  jobId: string | undefined,
  opts?: JobFindByCustomerOptions,
): Promise<Job[]> {
  if (jobId) {
    const job = await jobRepo.findById(tenantId, jobId);
    return job && job.customerId === customerId ? [job] : [];
  }
  if (!jobRepo.findByCustomer) throw new Error('JobRepository.findByCustomer is required');
  return jobRepo.findByCustomer(tenantId, customerId, opts);
}
