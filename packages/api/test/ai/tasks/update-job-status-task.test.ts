import { describe, it, expect } from 'vitest';
import {
  UpdateJobStatusTaskHandler,
  resolveTechJob,
} from '../../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { InMemoryJobRepository, Job, JobStatus } from '../../../src/jobs/job';

const TENANT = 'tenant-1';
const TECH = 'tech-1';

let seq = 0;
function job(overrides: Partial<Job> = {}): Job {
  seq += 1;
  return {
    id: `job-${seq}`,
    tenantId: TENANT,
    customerId: 'c-1',
    locationId: 'loc-1',
    jobNumber: `JOB-${seq}`,
    summary: 'Water heater install',
    status: 'scheduled' as JobStatus,
    priority: 'normal',
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function repoWith(jobs: Job[]): Promise<InMemoryJobRepository> {
  const repo = new InMemoryJobRepository();
  for (const j of jobs) await repo.create(j);
  return repo;
}

function ctx(entities: Record<string, unknown>, userId = TECH): TaskContext {
  return {
    tenantId: TENANT,
    userId,
    message: 'voice command',
    existingEntities: entities,
  };
}

describe('resolveTechJob — legal-source-status scoping', () => {
  it('"complete" only considers in_progress jobs', async () => {
    const repo = await repoWith([
      job({ id: 'a', status: 'in_progress', summary: 'Henderson water heater' }),
      job({ id: 'b', status: 'scheduled', summary: 'Henderson furnace' }), // not started → ineligible
    ]);
    const id = await resolveTechJob(repo, TENANT, { jobReference: 'Henderson', target: 'completed' });
    expect(id).toBe('a');
  });

  it('"start" only considers scheduled jobs', async () => {
    const repo = await repoWith([
      job({ id: 'a', status: 'in_progress', summary: 'Miller install' }), // already started → ineligible
      job({ id: 'b', status: 'scheduled', summary: 'Miller install' }),
    ]);
    const id = await resolveTechJob(repo, TENANT, { jobReference: 'Miller', target: 'in_progress' });
    expect(id).toBe('b');
  });

  it('prefers the speaker\'s own assigned job when that leaves candidates', async () => {
    const repo = await repoWith([
      job({ id: 'mine', status: 'in_progress', summary: 'install', assignedTechnicianId: TECH }),
      job({ id: 'other', status: 'in_progress', summary: 'install', assignedTechnicianId: 'tech-2' }),
    ]);
    const id = await resolveTechJob(repo, TENANT, { technicianId: TECH, target: 'completed' });
    expect(id).toBe('mine');
  });

  it('still resolves for an owner not assigned to any job (does not empty the set)', async () => {
    const repo = await repoWith([
      job({ id: 'only', status: 'in_progress', assignedTechnicianId: 'tech-2' }),
    ]);
    const id = await resolveTechJob(repo, TENANT, { technicianId: 'owner-x', target: 'completed' });
    expect(id).toBe('only');
  });

  it('returns undefined when the reference matches several (ambiguous → review)', async () => {
    const repo = await repoWith([
      job({ id: 'a', status: 'in_progress', summary: 'Smith kitchen' }),
      job({ id: 'b', status: 'in_progress', summary: 'Smith bathroom' }),
    ]);
    const id = await resolveTechJob(repo, TENANT, { jobReference: 'Smith', target: 'completed' });
    expect(id).toBeUndefined();
  });

  it('returns undefined when the reference matches nothing', async () => {
    const repo = await repoWith([job({ id: 'a', status: 'in_progress', summary: 'Jones job' })]);
    const id = await resolveTechJob(repo, TENANT, { jobReference: 'Nobody', target: 'completed' });
    expect(id).toBeUndefined();
  });

  it('no repo → undefined', async () => {
    expect(await resolveTechJob(undefined, TENANT, { target: 'completed' })).toBeUndefined();
  });
});

describe('UpdateJobStatusTaskHandler', () => {
  it('resolves the job and builds an approvable proposal (no missing fields)', async () => {
    const repo = await repoWith([job({ id: 'h', status: 'in_progress', summary: 'Henderson job' })]);
    const handler = new UpdateJobStatusTaskHandler(repo);

    const { proposal, taskType } = await handler.handle(
      ctx({ jobReference: 'Henderson', jobStatusTarget: 'completed' }),
    );

    expect(taskType).toBe('update_job_status');
    expect(proposal.payload).toMatchObject({ jobId: 'h', targetStatus: 'completed' });
    expect(proposal.payload).not.toHaveProperty('jobReference');
    // No missing fields → autonomous capture can leave 'draft' status only
    // via the trust/confidence path, not via a missingFields block.
    const ctxMissing = (proposal.sourceContext as Record<string, unknown> | undefined)?.missingFields;
    expect(ctxMissing).toBeUndefined();
  });

  it('holds for review when the job is ambiguous (carries the reference + missingFields)', async () => {
    const repo = await repoWith([
      job({ id: 'a', status: 'in_progress', summary: 'Smith one' }),
      job({ id: 'b', status: 'in_progress', summary: 'Smith two' }),
    ]);
    const handler = new UpdateJobStatusTaskHandler(repo);

    const { proposal } = await handler.handle(
      ctx({ jobReference: 'Smith', jobStatusTarget: 'completed' }),
    );

    expect(proposal.status).toBe('draft');
    expect(proposal.payload).toMatchObject({ jobReference: 'Smith', targetStatus: 'completed' });
    expect(proposal.payload).not.toHaveProperty('jobId');
    expect((proposal.sourceContext as Record<string, unknown>).missingFields).toContain('jobId');
  });

  it('holds for review when the classifier did not extract a target', async () => {
    const repo = await repoWith([job({ status: 'in_progress' })]);
    const handler = new UpdateJobStatusTaskHandler(repo);

    const { proposal } = await handler.handle(ctx({ jobReference: 'Henderson' }));

    expect(proposal.status).toBe('draft');
    expect((proposal.sourceContext as Record<string, unknown>).missingFields).toContain(
      'targetStatus',
    );
  });

  it('without a jobRepo, carries the reference for the review UI to resolve', async () => {
    const handler = new UpdateJobStatusTaskHandler();
    const { proposal } = await handler.handle(
      ctx({ jobReference: 'Henderson', jobStatusTarget: 'completed' }),
    );
    expect(proposal.payload).toMatchObject({ jobReference: 'Henderson', targetStatus: 'completed' });
    expect((proposal.sourceContext as Record<string, unknown>).missingFields).toContain('jobId');
  });
});
