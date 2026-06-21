import { v4 as uuidv4 } from 'uuid';
import { Job, JobStatus, JobRepository } from './job';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { ForbiddenError, NotFoundError, ValidationError } from '../shared/errors';

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

/**
 * §5.8 Backward status moves. Canonical forward order of the linear job
 * lifecycle. `canceled` is intentionally absent: it is a lateral terminal
 * state, not a point on the progression, so cancel/reopen moves are never
 * classified as "backward".
 */
export const JOB_STATUS_ORDER: Record<Exclude<JobStatus, 'canceled'>, number> = {
  new: 0,
  scheduled: 1,
  in_progress: 2,
  completed: 3,
};

/**
 * §5.8 Roles permitted to move a job backward in status. The live stack's
 * RBAC has no separate `admin` role — `owner` is the privileged equivalent
 * the story's "owner or admin" maps onto.
 */
export const BACKWARD_MOVE_ROLES: readonly string[] = ['owner'];

/**
 * True when `to` sits earlier on the linear lifecycle than `from`.
 * Transitions touching `canceled` (which has no ordinal) are never backward.
 */
export function isBackwardTransition(from: JobStatus, to: JobStatus): boolean {
  const fromOrder = JOB_STATUS_ORDER[from as Exclude<JobStatus, 'canceled'>];
  const toOrder = JOB_STATUS_ORDER[to as Exclude<JobStatus, 'canceled'>];
  if (fromOrder === undefined || toOrder === undefined) return false;
  return toOrder < fromOrder;
}

/** A status is terminal when it has no outbound transitions in the map. */
export function isTerminalJobStatus(status: JobStatus): boolean {
  return (JOB_STATUS_TRANSITIONS[status]?.length ?? 0) === 0;
}

export async function transitionJobStatus(
  tenantId: string,
  jobId: string,
  newStatus: JobStatus,
  actorId: string,
  actorRole: string,
  jobRepo: JobRepository,
  timelineRepo: JobTimelineRepository,
  auditRepo?: AuditRepository,
  /**
   * §5.8 Required when the move is backward (owner-only). Ignored for
   * forward/lateral moves. Recorded on the timeline entry and audit event.
   */
  reason?: string,
): Promise<{ job: Job; timelineEntry: JobTimelineEntry }> {
  const job = await jobRepo.findById(tenantId, jobId);
  if (!job) throw new NotFoundError('Job', jobId);

  const oldStatus = job.status;
  const backward = isBackwardTransition(oldStatus, newStatus);
  const trimmedReason = reason?.trim() || undefined;

  if (backward) {
    // §5.8 — backward moves exist to fix mistakes, but only an owner may
    // make them, always with a recorded reason. Terminal statuses
    // (e.g. 'completed', whose side effects — auto-invoice, completion
    // milestones, feedback SMS — have already fired) can never be undone
    // this way; reversing money state is out of scope here.
    if (!BACKWARD_MOVE_ROLES.includes(actorRole)) {
      throw new ForbiddenError(
        `Only an owner can move a job backward (${oldStatus} → ${newStatus})`,
      );
    }
    if (!trimmedReason) {
      throw new ValidationError('A reason is required to move a job backward in status');
    }
    if (isTerminalJobStatus(oldStatus)) {
      throw new ValidationError(
        `Cannot move a job backward out of terminal status '${oldStatus}'`,
      );
    }
  } else if (!isValidTransition(oldStatus, newStatus)) {
    throw new ValidationError(`Invalid transition from ${oldStatus} to ${newStatus}`);
  }

  const now = new Date();
  const updated = await jobRepo.update(tenantId, jobId, {
    status: newStatus,
    updatedAt: now,
    // Stamp the explicit completion time exactly once. JOB_STATUS_TRANSITIONS
    // forbids leaving 'completed', so this never gets cleared post-write.
    ...(newStatus === 'completed' ? { completedAt: now } : {}),
  });

  const entry: JobTimelineEntry = {
    id: uuidv4(),
    tenantId,
    jobId,
    eventType: JOB_TIMELINE_EVENT_TYPES.STATUS_CHANGE,
    fromStatus: oldStatus,
    toStatus: newStatus,
    description: backward
      ? `Status moved backward from ${oldStatus} to ${newStatus} (reason: ${trimmedReason})`
      : `Status changed from ${oldStatus} to ${newStatus}`,
    actorId,
    actorRole,
    ...(backward ? { metadata: { backward: true, reason: trimmedReason } } : {}),
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
      metadata: {
        fromStatus: oldStatus,
        toStatus: newStatus,
        ...(backward ? { backward: true, reason: trimmedReason } : {}),
      },
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
