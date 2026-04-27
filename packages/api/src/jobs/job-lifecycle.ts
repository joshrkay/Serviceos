import { v4 as uuidv4 } from 'uuid';
import { Job, JobStatus, JobRepository } from './job';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { NotFoundError, ValidationError } from '../shared/errors';

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

export const JOB_TIMELINE_EVENT_TYPES = {
  STATUS_CHANGE: 'status_change',
  DELAY_ACKNOWLEDGED: 'delay_acknowledged',
} as const;

export interface DelayAcknowledgmentMetadata extends Record<string, unknown> {
  appointmentId: string;
  isRunningBehind: boolean;
  delayMinutes?: 10 | 15 | 20 | 60;
  reasonCode?: string;
  actorId: string;
  actorRole: string;
  timestamp: string;
  inferredTriggerState: 'running_behind' | 'on_time';
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
  if (!job) throw new NotFoundError('Job', jobId);

  if (!isValidTransition(job.status, newStatus)) {
    throw new ValidationError(`Invalid transition from ${job.status} to ${newStatus}`);
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
    eventType: JOB_TIMELINE_EVENT_TYPES.STATUS_CHANGE,
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

  if (!updated) throw new Error('Failed to update job status');
  return { job: updated, timelineEntry: entry };
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

export async function addDelayAcknowledgmentTimelineEntry(
  tenantId: string,
  jobId: string,
  actorId: string,
  actorRole: string,
  timelineRepo: JobTimelineRepository,
  metadata: DelayAcknowledgmentMetadata
): Promise<JobTimelineEntry> {
  if (metadata.isRunningBehind && metadata.delayMinutes === undefined) {
    throw new ValidationError('delayMinutes is required when isRunningBehind is true');
  }

  const description = metadata.isRunningBehind
    ? `Delay acknowledged (${metadata.delayMinutes}m)`
    : 'Delay cleared';

  return addTimelineEntry(
    tenantId,
    jobId,
    JOB_TIMELINE_EVENT_TYPES.DELAY_ACKNOWLEDGED,
    description,
    actorId,
    actorRole,
    timelineRepo,
    metadata
  );
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
