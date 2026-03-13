import {
  transitionJobStatus,
  addTimelineEntry,
  isValidTransition,
  InMemoryJobTimelineRepository,
} from '../../src/jobs/job-lifecycle';
import { createJob, InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryAuditRepository } from '../../src/audit/audit';

describe('P1-006 — Job lifecycle and timeline events', () => {
  let jobRepo: InMemoryJobRepository;
  let timelineRepo: InMemoryJobTimelineRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    jobRepo = new InMemoryJobRepository();
    timelineRepo = new InMemoryJobTimelineRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('happy path — transitions job from new to scheduled', async () => {
    const job = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Test', createdBy: 'u-1' },
      jobRepo
    );

    const { job: updated, timelineEntry } = await transitionJobStatus(
      'tenant-1', job.id, 'scheduled', 'u-1', 'dispatcher', jobRepo, timelineRepo, auditRepo
    );

    expect(updated.status).toBe('scheduled');
    expect(timelineEntry.fromStatus).toBe('new');
    expect(timelineEntry.toStatus).toBe('scheduled');
    expect(timelineEntry.eventType).toBe('status_change');
  });

  it('happy path — full lifecycle: new → scheduled → in_progress → completed', async () => {
    const job = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Full lifecycle', createdBy: 'u-1' },
      jobRepo
    );

    await transitionJobStatus('tenant-1', job.id, 'scheduled', 'u-1', 'dispatcher', jobRepo, timelineRepo);
    await transitionJobStatus('tenant-1', job.id, 'in_progress', 'u-2', 'technician', jobRepo, timelineRepo);
    await transitionJobStatus('tenant-1', job.id, 'completed', 'u-2', 'technician', jobRepo, timelineRepo);

    const timeline = await timelineRepo.findByJob('tenant-1', job.id);
    expect(timeline).toHaveLength(3);
    expect(timeline[0].toStatus).toBe('scheduled');
    expect(timeline[1].toStatus).toBe('in_progress');
    expect(timeline[2].toStatus).toBe('completed');
  });

  it('happy path — canceled job can be reopened', async () => {
    const job = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Cancel test', createdBy: 'u-1' },
      jobRepo
    );

    await transitionJobStatus('tenant-1', job.id, 'canceled', 'u-1', 'owner', jobRepo, timelineRepo);
    const { job: reopened } = await transitionJobStatus(
      'tenant-1', job.id, 'new', 'u-1', 'owner', jobRepo, timelineRepo
    );

    expect(reopened.status).toBe('new');
  });

  it('happy path — adds custom timeline entry', async () => {
    const job = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Test', createdBy: 'u-1' },
      jobRepo
    );

    await addTimelineEntry(
      'tenant-1', job.id, 'note_added', 'Customer called about appointment', 'u-1', 'dispatcher',
      timelineRepo
    );

    const timeline = await timelineRepo.findByJob('tenant-1', job.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].eventType).toBe('note_added');
  });

  it('validation — rejects invalid transition', async () => {
    const job = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Test', createdBy: 'u-1' },
      jobRepo
    );

    await expect(
      transitionJobStatus('tenant-1', job.id, 'completed', 'u-1', 'owner', jobRepo, timelineRepo)
    ).rejects.toThrow('Invalid transition from new to completed');
  });

  it('validation — completed is terminal', () => {
    expect(isValidTransition('completed', 'new')).toBe(false);
    expect(isValidTransition('completed', 'scheduled')).toBe(false);
    expect(isValidTransition('completed', 'in_progress')).toBe(false);
  });

  it('validation — rejects transition for non-existent job', async () => {
    await expect(
      transitionJobStatus('tenant-1', 'nonexistent', 'scheduled', 'u-1', 'owner', jobRepo, timelineRepo)
    ).rejects.toThrow('Job not found');
  });
});
