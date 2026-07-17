/**
 * UpdateJobExecutionHandler tests (B7 — feat: voice-transcript-and-agent-paths).
 *
 * Applies a `update_job` proposal's field delta (status/priority/title/
 * description) to a real job row via the `updateJob` domain function and
 * emits a `job.updated` audit event.
 */
import { describe, it, expect, vi } from 'vitest';
import { UpdateJobExecutionHandler } from '../../../src/proposals/execution/update-job-handler';
import { InMemoryJobRepository, type Job, type JobRepository } from '../../../src/jobs/job';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import type { Proposal } from '../../../src/proposals/proposal';

const TENANT = 't-1';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    tenantId: TENANT,
    customerId: 'cust-1',
    locationId: 'loc-1',
    jobNumber: 'JOB-0001',
    summary: 'Water heater replacement',
    status: 'scheduled',
    priority: 'normal',
    createdBy: 'u-1',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

function makeProposal(payload: Record<string, unknown>, overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-1',
    tenantId: TENANT,
    proposalType: 'update_job',
    status: 'approved',
    payload,
    summary: 'Mark job in progress',
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Proposal;
}

describe('UpdateJobExecutionHandler', () => {
  it('applies a status change and emits a job.updated audit event', async () => {
    const jobRepo = new InMemoryJobRepository();
    const job = await jobRepo.create(makeJob());
    const auditRepo = new InMemoryAuditRepository();
    const handler = new UpdateJobExecutionHandler(jobRepo, auditRepo);

    const result = await handler.execute(
      makeProposal({ jobId: job.id, status: 'in_progress' }),
      { tenantId: TENANT, executedBy: 'u-1' },
    );

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(job.id);

    const updated = await jobRepo.findById(TENANT, job.id);
    expect(updated?.status).toBe('in_progress');

    const events = await auditRepo.findByEntity(TENANT, 'job', job.id);
    expect(events.some((e) => e.eventType === 'job.updated')).toBe(true);
  });

  it('applies a priority change', async () => {
    const jobRepo = new InMemoryJobRepository();
    const job = await jobRepo.create(makeJob());
    const handler = new UpdateJobExecutionHandler(jobRepo);

    const result = await handler.execute(
      makeProposal({ jobId: job.id, priority: 'urgent' }),
      { tenantId: TENANT, executedBy: 'u-1' },
    );

    expect(result.success).toBe(true);
    const updated = await jobRepo.findById(TENANT, job.id);
    expect(updated?.priority).toBe('urgent');
  });

  it('applies title and description changes (mapped to summary / problemDescription)', async () => {
    const jobRepo = new InMemoryJobRepository();
    const job = await jobRepo.create(makeJob());
    const handler = new UpdateJobExecutionHandler(jobRepo);

    const result = await handler.execute(
      makeProposal({
        jobId: job.id,
        title: 'Water heater — 2nd unit',
        description: 'Customer reports no hot water on the east side',
      }),
      { tenantId: TENANT, executedBy: 'u-1' },
    );

    expect(result.success).toBe(true);
    const updated = await jobRepo.findById(TENANT, job.id);
    expect(updated?.summary).toBe('Water heater — 2nd unit');
    expect(updated?.problemDescription).toBe('Customer reports no hot water on the east side');
  });

  it('applies a combined status + priority + title + description delta in one write', async () => {
    const jobRepo = new InMemoryJobRepository();
    const job = await jobRepo.create(makeJob());
    const handler = new UpdateJobExecutionHandler(jobRepo);

    const result = await handler.execute(
      makeProposal({
        jobId: job.id,
        status: 'completed',
        priority: 'high',
        title: 'Renamed job',
        description: 'Updated notes',
      }),
      { tenantId: TENANT, executedBy: 'u-1' },
    );

    expect(result.success).toBe(true);
    const updated = await jobRepo.findById(TENANT, job.id);
    expect(updated?.status).toBe('completed');
    expect(updated?.priority).toBe('high');
    expect(updated?.summary).toBe('Renamed job');
    expect(updated?.problemDescription).toBe('Updated notes');
  });

  it('fails cleanly when jobId is missing — no partial write', async () => {
    const jobRepo = new InMemoryJobRepository();
    const job = await jobRepo.create(makeJob());
    const handler = new UpdateJobExecutionHandler(jobRepo);

    const result = await handler.execute(
      makeProposal({ status: 'in_progress' }),
      { tenantId: TENANT, executedBy: 'u-1' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/jobId/i);

    const unchanged = await jobRepo.findById(TENANT, job.id);
    expect(unchanged?.status).toBe('scheduled');
  });

  it('fails cleanly when the job does not exist in this tenant', async () => {
    const jobRepo = new InMemoryJobRepository();
    const handler = new UpdateJobExecutionHandler(jobRepo);

    const result = await handler.execute(
      makeProposal({ jobId: 'nonexistent-job', status: 'in_progress' }),
      { tenantId: TENANT, executedBy: 'u-1' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('fails cleanly on wrong tenant — no cross-tenant write', async () => {
    const jobRepo = new InMemoryJobRepository();
    const job = await jobRepo.create(makeJob());
    const handler = new UpdateJobExecutionHandler(jobRepo);

    const result = await handler.execute(
      makeProposal({ jobId: job.id, status: 'in_progress' }, { tenantId: 't-other' }),
      { tenantId: 't-other', executedBy: 'u-1' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);

    const unchanged = await jobRepo.findById(TENANT, job.id);
    expect(unchanged?.status).toBe('scheduled');
  });

  it('fails cleanly when the payload carries no editable field — no partial write', async () => {
    const jobRepo = new InMemoryJobRepository();
    const job = await jobRepo.create(makeJob());
    const handler = new UpdateJobExecutionHandler(jobRepo);

    const result = await handler.execute(
      makeProposal({ jobId: job.id }),
      { tenantId: TENANT, executedBy: 'u-1' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/at least one field/i);

    const unchanged = await jobRepo.findById(TENANT, job.id);
    expect(unchanged?.status).toBe('scheduled');
  });

  it('ignores an invalid status/priority value rather than writing it', async () => {
    const jobRepo = new InMemoryJobRepository();
    const job = await jobRepo.create(makeJob());
    const handler = new UpdateJobExecutionHandler(jobRepo);

    // Only a bogus status — nothing valid to write, so the handler refuses
    // rather than silently no-op-succeeding.
    const result = await handler.execute(
      makeProposal({ jobId: job.id, status: 'not_a_real_status' }),
      { tenantId: TENANT, executedBy: 'u-1' },
    );

    expect(result.success).toBe(false);
    const unchanged = await jobRepo.findById(TENANT, job.id);
    expect(unchanged?.status).toBe('scheduled');
  });

  it('reports isFullyWired() = false without a job repo and refuses (no synthetic success)', async () => {
    const handler = new UpdateJobExecutionHandler();
    expect(handler.isFullyWired()).toBe(false);
    const result = await handler.execute(
      makeProposal({ jobId: 'job-1', status: 'in_progress' }),
      { tenantId: TENANT, executedBy: 'u-1' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/handler_not_wired/);
  });

  it('propagates repo errors as thrown exceptions', async () => {
    const failingRepo = {
      update: vi.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as JobRepository;
    const handler = new UpdateJobExecutionHandler(failingRepo);
    await expect(
      handler.execute(
        makeProposal({ jobId: 'job-1', status: 'in_progress' }),
        { tenantId: TENANT, executedBy: 'u-1' },
      ),
    ).rejects.toThrow(/db down/);
  });

  it('registry wires the jobRepo: a real job row and its status change apply through the registry handler', async () => {
    const jobRepo = new InMemoryJobRepository();
    const job = await jobRepo.create(makeJob());
    const auditRepo = new InMemoryAuditRepository();
    const { createExecutionHandlerRegistry } = await import(
      '../../../src/proposals/execution/handlers'
    );
    const registry = createExecutionHandlerRegistry({ jobRepo, auditRepo });
    const h = registry.get('update_job')!;
    const result = await h.execute(
      makeProposal({ jobId: job.id, status: 'in_progress' }),
      { tenantId: TENANT, executedBy: 'u-1' },
    );
    expect(result.success).toBe(true);
    const updated = await jobRepo.findById(TENANT, job.id);
    expect(updated?.status).toBe('in_progress');
  });

  it('registry omits update_job entirely when no jobRepo is wired', async () => {
    const { createExecutionHandlerRegistry } = await import(
      '../../../src/proposals/execution/handlers'
    );
    const registry = createExecutionHandlerRegistry({});
    expect(registry.has('update_job')).toBe(false);
  });
});
