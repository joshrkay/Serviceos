import { v4 as uuidv4 } from 'uuid';
import { Job, JobStatus, JobRepository } from './job';
import { AuditRepository, createAuditEvent } from '../audit/audit';

export interface JobTimelineEntry {
  id: string;
  tenantId: string;
  jobId: string;
  eventType: string;
  fromStatus?: JobStatus;
  toStatus?: JobStatus;
  description: string;
  actorId: string;
  actorRole: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface JobTimelineRepository {
  create(entry: JobTimelineEntry): Promise<JobTimelineEntry>;
  findByJob(tenantId: string, jobId: string): Promise<JobTimelineEntry[]>;
}

export const JOB_STATUS_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  new: ['scheduled', 'canceled'],
  scheduled: ['in_progress', 'canceled'],
  in_progress: ['completed', 'scheduled', 'canceled'],
  completed: [],
  canceled: ['new'],
};

export function isValidTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export async function transitionJobStatus(
  tenantId: string,
  jobId: string,
  newStatus: JobStatus,
  actorId: string,
  actorRole: string,
  jobRepo: JobRepository,
  timelineRepo: JobTimelineRepository,
  auditRepo?: AuditRepository
): Promise<{ job: Job; timelineEntry: JobTimelineEntry }> {
  const job = await jobRepo.findById(tenantId, jobId);
  if (!job) throw new Error('Job not found');

  if (!isValidTransition(job.status, newStatus)) {
    throw new Error(`Invalid transition from ${job.status} to ${newStatus}`);
  }

  const oldStatus = job.status;
  const updated = await jobRepo.update(tenantId, jobId, {
    status: newStatus,
    updatedAt: new Date(),
  });

  const entry: JobTimelineEntry = {
    id: uuidv4(),
    tenantId,
    jobId,
    eventType: 'status_change',
    fromStatus: oldStatus,
    toStatus: newStatus,
    description: `Status changed from ${oldStatus} to ${newStatus}`,
    actorId,
    actorRole,
    createdAt: new Date(),
  };

  await timelineRepo.create(entry);

  if (auditRepo) {
    const event = createAuditEvent({
      tenantId,
      actorId,
      actorRole,
      eventType: 'job.status_changed',
      entityType: 'job',
      entityId: jobId,
      metadata: { fromStatus: oldStatus, toStatus: newStatus },
    });
    await auditRepo.create(event);
  }

  return { job: updated!, timelineEntry: entry };
}

export async function addTimelineEntry(
  tenantId: string,
  jobId: string,
  eventType: string,
  description: string,
  actorId: string,
  actorRole: string,
  timelineRepo: JobTimelineRepository,
  metadata?: Record<string, unknown>
): Promise<JobTimelineEntry> {
  const entry: JobTimelineEntry = {
    id: uuidv4(),
    tenantId,
    jobId,
    eventType,
    description,
    actorId,
    actorRole,
    metadata,
    createdAt: new Date(),
  };

  return timelineRepo.create(entry);
}

export class InMemoryJobTimelineRepository implements JobTimelineRepository {
  private entries: JobTimelineEntry[] = [];

  async create(entry: JobTimelineEntry): Promise<JobTimelineEntry> {
    this.entries.push({ ...entry });
    return { ...entry };
  }

  async findByJob(tenantId: string, jobId: string): Promise<JobTimelineEntry[]> {
    return this.entries
      .filter((e) => e.tenantId === tenantId && e.jobId === jobId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((e) => ({ ...e }));
  }
}
