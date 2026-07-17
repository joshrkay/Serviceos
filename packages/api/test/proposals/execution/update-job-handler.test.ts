/**
 * UpdateJobExecutionHandler tests (B7 — feat: voice-transcript-and-agent-paths).
 *
 * A `update_job` proposal's field delta is applied to a real job row:
 *   - STATUS changes route through the governed lifecycle transition
 *     (transitionJobStatus) — validation, completedAt stamp, timeline entry,
 *     and the completion side effects (auto-invoice + milestone minting).
 *   - non-status fields (title/priority/description) go through updateJob.
 * A rejected transition fails the whole execution cleanly (all-or-nothing) —
 * no field delta leaks through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdateJobExecutionHandler } from '../../../src/proposals/execution/update-job-handler';
import { InMemoryJobRepository, type Job, type JobRepository } from '../../../src/jobs/job';
import { InMemoryJobTimelineRepository } from '../../../src/jobs/job-lifecycle';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { runJobCompletionEffects } from '../../../src/jobs/completion-effects';
import type { JobCompletionEffectsDeps } from '../../../src/jobs/completion-effects';
import type { Proposal } from '../../../src/proposals/proposal';

// Completion effects are covered by their own unit tests
// (test/routes/jobs.route.test.ts + invoices/*); here we only assert the
// HANDLER invokes them (or degrades) — so mock the module.
vi.mock('../../../src/jobs/completion-effects', () => ({
  runJobCompletionEffects: vi.fn(async () => {}),
}));

const TENANT = 't-1';
const COMPLETION_DEPS = {} as unknown as JobCompletionEffectsDeps;

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
  beforeEach(() => {
    vi.mocked(runJobCompletionEffects).mockClear();
  });

  it('routes a status change through the governed transition (timeline + audit)', async () => {
    const jobRepo = new InMemoryJobRepository();
    const job = await jobRepo.create(makeJob());
    const auditRepo = new InMemoryAuditRepository();
    const timelineRepo = new InMemoryJobTimelineRepository();
    const handler = new UpdateJobExecutionHandler(jobRepo, auditRepo, timelineRepo);

    const result = await handler.execute(
      makeProposal({ jobId: job.id, status: 'in_progress' }),
      { tenantId: TENANT, executedBy: 'u-1' },
    );

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(job.id);

    const updated = await jobRepo.findById(TENANT, job.id);
    expect(updated?.status).toBe('in_progress');

    // Timeline entry written by the governed transition.
    const timeline = await timelineRepo.findByJob(TENANT, job.id);
    expect(timeline.some((e) => e.toStatus === 'in_progress')).toBe(true);

    // Both the transition audit and the consolidated job.updated audit fire.
    const events = await auditRepo.findByEntity(TENANT, 'job', job.id);
    expect(events.some((e) => e.eventType === 'job.status_changed')).toBe(true);
    expect(events.some((e) => e.eventType === 'job.updated')).toBe(true);
  });

  it('applies a priority change (no status → no transition needed)', async () => {
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
    expect(updated?.status).toBe('scheduled');
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

  it('applies a combined status + priority + title + description delta in one execution', async () => {
    const jobRepo = new InMemoryJobRepository();
    // in_progress → completed is a valid transition.
    const job = await jobRepo.create(makeJob({ status: 'in_progress' }));
    const timelineRepo = new InMemoryJobTimelineRepository();
    const handler = new UpdateJobExecutionHandler(jobRepo, undefined, timelineRepo, COMPLETION_DEPS);

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
    expect(updated?.completedAt).toBeInstanceOf(Date);
    expect(updated?.priority).toBe('high');
    expect(updated?.summary).toBe('Renamed job');
    expect(updated?.problemDescription).toBe('Updated notes');
  });

  it('a completed transition stamps completedAt and runs the completion effects', async () => {
    const jobRepo = new InMemoryJobRepository();
    const job = await jobRepo.create(makeJob({ status: 'in_progress' }));
    const timelineRepo = new InMemoryJobTimelineRepository();
    const handler = new UpdateJobExecutionHandler(jobRepo, undefined, timelineRepo, COMPLETION_DEPS);

    const result = await handler.execute(
      makeProposal({ jobId: job.id, status: 'completed' }),
      { tenantId: TENANT, executedBy: 'u-1' },
    );

    expect(result.success).toBe(true);
    const updated = await jobRepo.findById(TENANT, job.id);
    expect(updated?.status).toBe('completed');
    expect(updated?.completedAt).toBeInstanceOf(Date);

    // Auto-invoice + milestone minting run once, against the completed job.
    expect(runJobCompletionEffects).toHaveBeenCalledTimes(1);
    const [passedDeps, passedJob] = vi.mocked(runJobCompletionEffects).mock.calls[0];
    expect(passedDeps).toBe(COMPLETION_DEPS);
    expect(passedJob.id).toBe(job.id);
    expect(passedJob.status).toBe('completed');
    expect(passedJob.completedAt).toBeInstanceOf(Date);
  });

  it('degrades LOUDLY when completion deps are absent: warns, still completes + stamps completedAt', async () => {
    const jobRepo = new InMemoryJobRepository();
    const job = await jobRepo.create(makeJob({ status: 'in_progress' }));
    const timelineRepo = new InMemoryJobTimelineRepository();
    const warn = vi.fn();
    const logger = { warn, error: vi.fn() };
    // No completionDeps (4th arg undefined).
    const handler = new UpdateJobExecutionHandler(jobRepo, undefined, timelineRepo, undefined, logger);

    const result = await handler.execute(
      makeProposal({ jobId: job.id, status: 'completed' }),
      { tenantId: TENANT, executedBy: 'u-1' },
    );

    expect(result.success).toBe(true);
    const updated = await jobRepo.findById(TENANT, job.id);
    expect(updated?.status).toBe('completed');
    expect(updated?.completedAt).toBeInstanceOf(Date);
    expect(runJobCompletionEffects).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/completion effects.*SKIPPED/i);
  });

  it('rejects an INVALID transition (canceled → completed) cleanly — NO partial write of the field delta', async () => {
    const jobRepo = new InMemoryJobRepository();
    const job = await jobRepo.create(makeJob({ status: 'canceled' }));
    const timelineRepo = new InMemoryJobTimelineRepository();
    const handler = new UpdateJobExecutionHandler(jobRepo, undefined, timelineRepo, COMPLETION_DEPS);

    const result = await handler.execute(
      // A bundled title edit MUST NOT land when the status move is rejected.
      makeProposal({ jobId: job.id, status: 'completed', title: 'Should not persist' }),
      { tenantId: TENANT, executedBy: 'u-1' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid transition/i);

    const unchanged = await jobRepo.findById(TENANT, job.id);
    expect(unchanged?.status).toBe('canceled');
    // All-or-nothing: the title delta did not persist.
    expect(unchanged?.summary).toBe('Water heater replacement');
    expect(unchanged?.completedAt).toBeUndefined();
    expect(runJobCompletionEffects).not.toHaveBeenCalled();
  });

  it('skips the transition when the status equals the current status (no invalid X→X move)', async () => {
    const jobRepo = new InMemoryJobRepository();
    const job = await jobRepo.create(makeJob({ status: 'scheduled' }));
    const timelineRepo = new InMemoryJobTimelineRepository();
    const handler = new UpdateJobExecutionHandler(jobRepo, undefined, timelineRepo);

    const result = await handler.execute(
      makeProposal({ jobId: job.id, status: 'scheduled', priority: 'high' }),
      { tenantId: TENANT, executedBy: 'u-1' },
    );

    expect(result.success).toBe(true);
    const updated = await jobRepo.findById(TENANT, job.id);
    expect(updated?.status).toBe('scheduled');
    expect(updated?.priority).toBe('high');
    // No transition ran → no timeline entry.
    expect(await timelineRepo.findByJob(TENANT, job.id)).toHaveLength(0);
  });

  it('fails cleanly when jobId is missing — no partial write', async () => {
    const jobRepo = new InMemoryJobRepository();
    const job = await jobRepo.create(makeJob());
    const handler = new UpdateJobExecutionHandler(jobRepo, undefined, new InMemoryJobTimelineRepository());

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
    const handler = new UpdateJobExecutionHandler(jobRepo, undefined, new InMemoryJobTimelineRepository());

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
    const handler = new UpdateJobExecutionHandler(jobRepo, undefined, new InMemoryJobTimelineRepository());

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
    const handler = new UpdateJobExecutionHandler(jobRepo, undefined, new InMemoryJobTimelineRepository());

    const result = await handler.execute(
      makeProposal({ jobId: job.id }),
      { tenantId: TENANT, executedBy: 'u-1' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/at least one field/i);

    const unchanged = await jobRepo.findById(TENANT, job.id);
    expect(unchanged?.status).toBe('scheduled');
  });

  it('ignores an invalid status value rather than writing it', async () => {
    const jobRepo = new InMemoryJobRepository();
    const job = await jobRepo.create(makeJob());
    const handler = new UpdateJobExecutionHandler(jobRepo, undefined, new InMemoryJobTimelineRepository());

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

  it('reports isFullyWired() = false without a timeline repo', async () => {
    const jobRepo = new InMemoryJobRepository();
    const handler = new UpdateJobExecutionHandler(jobRepo);
    expect(handler.isFullyWired()).toBe(false);
  });

  it('a status change without a timeline repo fails cleanly (handler_not_wired:timelineRepo)', async () => {
    const jobRepo = new InMemoryJobRepository();
    const job = await jobRepo.create(makeJob());
    const handler = new UpdateJobExecutionHandler(jobRepo); // no timelineRepo

    const result = await handler.execute(
      makeProposal({ jobId: job.id, status: 'in_progress' }),
      { tenantId: TENANT, executedBy: 'u-1' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/handler_not_wired:timelineRepo/);
    // No status write leaked through.
    const unchanged = await jobRepo.findById(TENANT, job.id);
    expect(unchanged?.status).toBe('scheduled');
  });

  it('propagates transient repo errors as thrown exceptions', async () => {
    const failingRepo = {
      findById: vi.fn(async () => makeJob()),
      update: vi.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as JobRepository;
    const handler = new UpdateJobExecutionHandler(
      failingRepo,
      undefined,
      new InMemoryJobTimelineRepository(),
    );
    await expect(
      handler.execute(
        makeProposal({ jobId: 'job-1', status: 'in_progress' }),
        { tenantId: TENANT, executedBy: 'u-1' },
      ),
    ).rejects.toThrow(/db down/);
  });

  it('registry wires jobRepo + timelineRepo: a real status change applies through the registry handler', async () => {
    const jobRepo = new InMemoryJobRepository();
    const job = await jobRepo.create(makeJob());
    const auditRepo = new InMemoryAuditRepository();
    const timelineRepo = new InMemoryJobTimelineRepository();
    const { createExecutionHandlerRegistry } = await import(
      '../../../src/proposals/execution/handlers'
    );
    const registry = createExecutionHandlerRegistry({ jobRepo, auditRepo, timelineRepo });
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
