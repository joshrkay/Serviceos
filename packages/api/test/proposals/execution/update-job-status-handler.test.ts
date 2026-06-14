import { describe, it, expect } from 'vitest';
import { UpdateJobStatusExecutionHandler } from '../../../src/proposals/execution/handlers';
import { InMemoryJobRepository, Job, JobStatus } from '../../../src/jobs/job';
import { InMemoryJobTimelineRepository } from '../../../src/jobs/job-lifecycle';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { Proposal } from '../../../src/proposals/proposal';

const TENANT = 'tenant-1';
const ACTOR = 'tech-1';

function job(status: JobStatus): Job {
  return {
    id: 'job-1',
    tenantId: TENANT,
    customerId: 'c-1',
    locationId: 'loc-1',
    jobNumber: 'JOB-1',
    summary: 'Henderson water heater',
    status,
    priority: 'normal',
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function proposal(payload: Record<string, unknown>): Proposal {
  return {
    id: 'p-1',
    tenantId: TENANT,
    proposalType: 'update_job_status',
    status: 'approved',
    payload,
    summary: 'update job',
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('UpdateJobStatusExecutionHandler', () => {
  it('completes an in_progress job: transitions, timelines, and audits', async () => {
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(job('in_progress'));
    const timelineRepo = new InMemoryJobTimelineRepository();
    const auditRepo = new InMemoryAuditRepository();
    const handler = new UpdateJobStatusExecutionHandler(jobRepo, timelineRepo, auditRepo);

    const result = await handler.execute(
      proposal({ jobId: 'job-1', targetStatus: 'completed' }),
      { tenantId: TENANT, executedBy: ACTOR },
    );

    expect(result).toEqual({ success: true, resultEntityId: 'job-1' });
    expect((await jobRepo.findById(TENANT, 'job-1'))?.status).toBe('completed');
    const timeline = await timelineRepo.findByJob(TENANT, 'job-1');
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ fromStatus: 'in_progress', toStatus: 'completed' });
    expect(auditRepo.getAll().some((e) => e.eventType === 'job.status_changed')).toBe(true);
  });

  it('starts a scheduled job (→ in_progress)', async () => {
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(job('scheduled'));
    const timelineRepo = new InMemoryJobTimelineRepository();
    const handler = new UpdateJobStatusExecutionHandler(jobRepo, timelineRepo);

    const result = await handler.execute(
      proposal({ jobId: 'job-1', targetStatus: 'in_progress' }),
      { tenantId: TENANT, executedBy: ACTOR },
    );

    expect(result.success).toBe(true);
    expect((await jobRepo.findById(TENANT, 'job-1'))?.status).toBe('in_progress');
  });

  it('fails cleanly on an illegal transition (complete a job that never started)', async () => {
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(job('scheduled')); // scheduled → completed is NOT legal
    const timelineRepo = new InMemoryJobTimelineRepository();
    const handler = new UpdateJobStatusExecutionHandler(jobRepo, timelineRepo);

    const result = await handler.execute(
      proposal({ jobId: 'job-1', targetStatus: 'completed' }),
      { tenantId: TENANT, executedBy: ACTOR },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid transition/i);
    // State is untouched.
    expect((await jobRepo.findById(TENANT, 'job-1'))?.status).toBe('scheduled');
  });

  it('fails when jobId is missing', async () => {
    const handler = new UpdateJobStatusExecutionHandler(new InMemoryJobRepository(), new InMemoryJobTimelineRepository());
    const result = await handler.execute(
      proposal({ targetStatus: 'completed' }),
      { tenantId: TENANT, executedBy: ACTOR },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/jobId/);
  });

  it('passthrough (success) when repos are not wired', async () => {
    const handler = new UpdateJobStatusExecutionHandler();
    const result = await handler.execute(
      proposal({ jobId: 'job-1', targetStatus: 'completed' }),
      { tenantId: TENANT, executedBy: ACTOR },
    );
    expect(result).toEqual({ success: true, resultEntityId: 'job-1' });
  });
});
