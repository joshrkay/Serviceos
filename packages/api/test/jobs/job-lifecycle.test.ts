import {
  transitionJobStatus,
  addTimelineEntry,
  addDelayAcknowledgmentTimelineEntry,
  isValidTransition,
  isBackwardTransition,
  isTerminalJobStatus,
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

  it('validation — closed is the terminal state; completed flows on to invoiced/closed', () => {
    // §5.1 — the canonical lifecycle now extends past completion.
    expect(isValidTransition('completed', 'invoiced')).toBe(true);
    expect(isValidTransition('completed', 'closed')).toBe(true);
    expect(isValidTransition('invoiced', 'closed')).toBe(true);
    expect(isValidTransition('closed', 'invoiced')).toBe(false);
    expect(isValidTransition('closed', 'new')).toBe(false);
    // forward map carries no backward edges (handled by the §5.8 owner path)
    expect(isValidTransition('completed', 'in_progress')).toBe(false);
  });

  it('happy path — full canonical lifecycle new → … → closed', async () => {
    const job = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Canonical', createdBy: 'u-1' },
      jobRepo
    );
    for (const next of ['scheduled', 'dispatched', 'in_progress', 'completed', 'invoiced', 'closed'] as const) {
      await transitionJobStatus('tenant-1', job.id, next, 'u-1', 'owner', jobRepo, timelineRepo);
    }
    const fresh = await jobRepo.findById('tenant-1', job.id);
    expect(fresh!.status).toBe('closed');
    const timeline = await timelineRepo.findByJob('tenant-1', job.id);
    expect(timeline.map((t) => t.toStatus)).toEqual([
      'scheduled', 'dispatched', 'in_progress', 'completed', 'invoiced', 'closed',
    ]);
  });

  it('validation — rejects transition for non-existent job', async () => {
    await expect(
      transitionJobStatus('tenant-1', 'nonexistent', 'scheduled', 'u-1', 'owner', jobRepo, timelineRepo)
    ).rejects.toThrow('Job not found');
  });

  it('happy path — records running-behind delay acknowledgement with fixed delay', async () => {
    const job = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Delay ack', createdBy: 'u-1' },
      jobRepo
    );

    const timelineEntry = await addDelayAcknowledgmentTimelineEntry(
      'tenant-1',
      job.id,
      'tech-1',
      'technician',
      timelineRepo,
      {
        appointmentId: 'apt-1',
        isRunningBehind: true,
        delayMinutes: 15,
        actorId: 'tech-1',
        actorRole: 'technician',
        timestamp: new Date().toISOString(),
        inferredTriggerState: 'running_behind',
      }
    );

    expect(timelineEntry.description).toBe('Delay acknowledged (15m)');
    expect(timelineEntry.eventType).toBe('delay_acknowledged');
  });

  it('validation — rejects running-behind delay acknowledgement without delayMinutes', async () => {
    const job = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Delay ack invalid', createdBy: 'u-1' },
      jobRepo
    );

    await expect(
      addDelayAcknowledgmentTimelineEntry(
        'tenant-1',
        job.id,
        'tech-1',
        'technician',
        timelineRepo,
        {
          appointmentId: 'apt-1',
          isRunningBehind: true,
          actorId: 'tech-1',
          actorRole: 'technician',
          timestamp: new Date().toISOString(),
          inferredTriggerState: 'running_behind',
        }
      )
    ).rejects.toThrow('delayMinutes is required when isRunningBehind is true');
  });
});

describe('P1-006 / §5.8 — Backward status moves', () => {
  let jobRepo: InMemoryJobRepository;
  let timelineRepo: InMemoryJobTimelineRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    jobRepo = new InMemoryJobRepository();
    timelineRepo = new InMemoryJobTimelineRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  async function seedInProgressJob() {
    const job = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Backward', createdBy: 'u-1' },
      jobRepo
    );
    await transitionJobStatus('tenant-1', job.id, 'scheduled', 'owner-1', 'owner', jobRepo, timelineRepo);
    await transitionJobStatus('tenant-1', job.id, 'in_progress', 'owner-1', 'owner', jobRepo, timelineRepo);
    return job;
  }

  it('classifies linear regressions as backward and ignores canceled/forward moves', () => {
    expect(isBackwardTransition('in_progress', 'scheduled')).toBe(true);
    expect(isBackwardTransition('scheduled', 'new')).toBe(true);
    expect(isBackwardTransition('in_progress', 'new')).toBe(true);
    // forward and lateral moves are never backward
    expect(isBackwardTransition('new', 'scheduled')).toBe(false);
    expect(isBackwardTransition('scheduled', 'in_progress')).toBe(false);
    // canceled has no ordinal — reopen/cancel are never "backward"
    expect(isBackwardTransition('canceled', 'new')).toBe(false);
    expect(isBackwardTransition('in_progress', 'canceled')).toBe(false);
    // §5.1 — 'closed' is the only terminal state; 'completed' now flows on
    expect(isTerminalJobStatus('closed')).toBe(true);
    expect(isTerminalJobStatus('completed')).toBe(false);
    expect(isTerminalJobStatus('in_progress')).toBe(false);
  });

  it('owner can move a job backward with a reason — recorded on timeline and audit', async () => {
    const job = await seedInProgressJob();

    const { job: updated, timelineEntry } = await transitionJobStatus(
      'tenant-1', job.id, 'scheduled', 'owner-1', 'owner', jobRepo, timelineRepo, auditRepo,
      'Customer rescheduled to next week'
    );

    expect(updated.status).toBe('scheduled');
    expect(timelineEntry.metadata).toMatchObject({ backward: true, reason: 'Customer rescheduled to next week' });
    expect(timelineEntry.description).toContain('moved backward');

    const events = await auditRepo.findByEntity('tenant-1', 'job', job.id);
    const statusEvent = events.find((e) => e.eventType === 'job.status_changed' && e.metadata?.backward === true);
    expect(statusEvent).toBeDefined();
    expect(statusEvent!.metadata).toMatchObject({
      fromStatus: 'in_progress',
      toStatus: 'scheduled',
      reason: 'Customer rescheduled to next week',
    });
  });

  it('rejects a backward move from a non-owner (dispatcher / technician)', async () => {
    const job = await seedInProgressJob();

    await expect(
      transitionJobStatus('tenant-1', job.id, 'scheduled', 'd-1', 'dispatcher', jobRepo, timelineRepo, auditRepo, 'fix it')
    ).rejects.toThrow('Only an owner can move a job backward');

    await expect(
      transitionJobStatus('tenant-1', job.id, 'scheduled', 't-1', 'technician', jobRepo, timelineRepo, auditRepo, 'fix it')
    ).rejects.toThrow('Only an owner can move a job backward');
  });

  it('rejects an owner backward move without a reason', async () => {
    const job = await seedInProgressJob();

    await expect(
      transitionJobStatus('tenant-1', job.id, 'scheduled', 'owner-1', 'owner', jobRepo, timelineRepo, auditRepo)
    ).rejects.toThrow('A reason is required to move a job backward');

    await expect(
      transitionJobStatus('tenant-1', job.id, 'scheduled', 'owner-1', 'owner', jobRepo, timelineRepo, auditRepo, '   ')
    ).rejects.toThrow('A reason is required to move a job backward');
  });

  it('never un-does a post-completion status, even for an owner with a reason', async () => {
    const job = await seedInProgressJob();
    await transitionJobStatus('tenant-1', job.id, 'completed', 'owner-1', 'owner', jobRepo, timelineRepo);

    // completed → in_progress (backward across the completion boundary)
    await expect(
      transitionJobStatus('tenant-1', job.id, 'in_progress', 'owner-1', 'owner', jobRepo, timelineRepo, auditRepo, 'mistaken completion')
    ).rejects.toThrow("Cannot move a job backward out of post-completion status 'completed'");

    // and once invoiced/closed the boundary still holds
    await transitionJobStatus('tenant-1', job.id, 'invoiced', 'owner-1', 'owner', jobRepo, timelineRepo);
    await expect(
      transitionJobStatus('tenant-1', job.id, 'completed', 'owner-1', 'owner', jobRepo, timelineRepo, auditRepo, 'oops')
    ).rejects.toThrow("Cannot move a job backward out of post-completion status 'invoiced'");
  });

  it('forward moves still require no reason and are allowed for any role', async () => {
    const job = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Forward', createdBy: 'u-1' },
      jobRepo
    );
    const { job: updated } = await transitionJobStatus(
      'tenant-1', job.id, 'scheduled', 'd-1', 'dispatcher', jobRepo, timelineRepo, auditRepo
    );
    expect(updated.status).toBe('scheduled');
  });
});
