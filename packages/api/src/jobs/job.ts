import { v4 as uuidv4 } from 'uuid';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { ValidationError } from '../shared/errors';

export type JobStatus = 'new' | 'scheduled' | 'in_progress' | 'completed' | 'canceled';
export type JobPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface Job {
  id: string;
  tenantId: string;
  customerId: string;
  locationId: string;
  jobNumber: string;
  summary: string;
  problemDescription?: string;
  status: JobStatus;
  priority: JobPriority;
  assignedTechnicianId?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateJobInput {
  tenantId: string;
  customerId: string;
  locationId: string;
  summary: string;
  problemDescription?: string;
  priority?: JobPriority;
  createdBy: string;
  actorRole?: string;
}

export interface UpdateJobInput {
  summary?: string;
  problemDescription?: string;
  priority?: JobPriority;
  assignedTechnicianId?: string;
}

export interface JobListOptions {
  status?: JobStatus;
  customerId?: string;
  technicianId?: string;
  search?: string;
  /** Pagination cap. Default 50, hard-capped server-side at 200. */
  limit?: number;
  /** Pagination offset. Default 0. */
  offset?: number;
  /** Sort direction applied to the canonical sort column (created_at). */
  sort?: 'asc' | 'desc';
}

export interface JobListResult {
  data: Job[];
  total: number;
}

export const DEFAULT_JOB_LIMIT = 50;
export const MAX_JOB_LIMIT = 200;

export interface JobRepository {
  create(job: Job): Promise<Job>;
  findById(tenantId: string, id: string): Promise<Job | null>;
  findByTenant(tenantId: string, options?: JobListOptions): Promise<Job[]>;
  /** P1-018: paginated `{ data, total }` form for list UIs. */
  listWithMeta?(tenantId: string, options?: JobListOptions): Promise<JobListResult>;
  update(tenantId: string, id: string, updates: Partial<Job>): Promise<Job | null>;
  getNextJobNumber(tenantId: string): Promise<number>;
}

export function validateJobInput(input: CreateJobInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.customerId) errors.push('customerId is required');
  if (!input.locationId) errors.push('locationId is required');
  if (!input.summary) errors.push('summary is required');
  if (input.summary && input.summary.length > 500) errors.push('summary must be 500 characters or fewer');
  if (!input.createdBy) errors.push('createdBy is required');
  if (input.priority && !['low', 'normal', 'high', 'urgent'].includes(input.priority)) {
    errors.push('Invalid priority');
  }
  return errors;
}

export async function createJob(
  input: CreateJobInput,
  repository: JobRepository,
  auditRepo?: AuditRepository
): Promise<Job> {
  const errors = validateJobInput(input);
  if (errors.length > 0) {
    throw new ValidationError(`Validation failed: ${errors.join(', ')}`, { errors });
  }

  const jobNumber = await repository.getNextJobNumber(input.tenantId);

  const job: Job = {
    id: uuidv4(),
    tenantId: input.tenantId,
    customerId: input.customerId,
    locationId: input.locationId,
    jobNumber: `JOB-${String(jobNumber).padStart(4, '0')}`,
    summary: input.summary,
    problemDescription: input.problemDescription,
    status: 'new',
    priority: input.priority || 'normal',
    createdBy: input.createdBy,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const created = await repository.create(job);

  if (auditRepo) {
    const event = createAuditEvent({
      tenantId: input.tenantId,
      actorId: input.createdBy,
      actorRole: input.actorRole ?? 'unknown',
      eventType: 'job.created',
      entityType: 'job',
      entityId: created.id,
    });
    await auditRepo.create(event);
  }

  return created;
}

export async function getJob(
  tenantId: string,
  id: string,
  repository: JobRepository
): Promise<Job | null> {
  return repository.findById(tenantId, id);
}

export async function updateJob(
  tenantId: string,
  id: string,
  input: UpdateJobInput,
  repository: JobRepository,
  actorId?: string,
  auditRepo?: AuditRepository
): Promise<Job | null> {
  const updated = await repository.update(tenantId, id, { ...input, updatedAt: new Date() });

  if (auditRepo && actorId && updated) {
    const event = createAuditEvent({
      tenantId,
      actorId,
      actorRole: 'unknown',
      eventType: 'job.updated',
      entityType: 'job',
      entityId: id,
      metadata: { changes: Object.keys(input) },
    });
    await auditRepo.create(event);
  }

  return updated;
}

export async function listJobs(
  tenantId: string,
  repository: JobRepository,
  options?: JobListOptions
): Promise<Job[]> {
  return repository.findByTenant(tenantId, options);
}

/**
 * P1-018: paginated job list. Falls back to in-memory pagination over
 * `findByTenant` when the repo doesn't implement `listWithMeta`.
 */
export async function listJobsWithMeta(
  tenantId: string,
  repository: JobRepository,
  options?: JobListOptions
): Promise<JobListResult> {
  if (repository.listWithMeta) {
    return repository.listWithMeta(tenantId, options);
  }
  const all = await repository.findByTenant(tenantId, { ...options, limit: undefined, offset: undefined });
  const limit = Math.min(options?.limit ?? DEFAULT_JOB_LIMIT, MAX_JOB_LIMIT);
  const offset = options?.offset ?? 0;
  return { data: all.slice(offset, offset + limit), total: all.length };
}

export class InMemoryJobRepository implements JobRepository {
  private jobs: Map<string, Job> = new Map();
  private counters: Map<string, number> = new Map();

  async create(job: Job): Promise<Job> {
    this.jobs.set(job.id, { ...job });
    return { ...job };
  }

  async findById(tenantId: string, id: string): Promise<Job | null> {
    const j = this.jobs.get(id);
    if (!j || j.tenantId !== tenantId) return null;
    return { ...j };
  }

  async findByTenant(tenantId: string, options?: JobListOptions): Promise<Job[]> {
    let results = Array.from(this.jobs.values()).filter((j) => j.tenantId === tenantId);
    if (options?.status) results = results.filter((j) => j.status === options.status);
    if (options?.customerId) results = results.filter((j) => j.customerId === options.customerId);
    if (options?.technicianId) results = results.filter((j) => j.assignedTechnicianId === options.technicianId);
    if (options?.search) {
      const q = options.search.toLowerCase();
      results = results.filter(
        (j) =>
          j.summary.toLowerCase().includes(q) ||
          j.jobNumber.toLowerCase().includes(q)
      );
    }
    // Default sort: createdAt DESC. P1-018 lets callers flip to ASC.
    const sortDir = options?.sort === 'asc' ? 1 : -1;
    results.sort((a, b) => sortDir * (a.createdAt.getTime() - b.createdAt.getTime()));
    if (options?.offset !== undefined || options?.limit !== undefined) {
      const offset = options?.offset ?? 0;
      const limit = options?.limit !== undefined
        ? Math.min(options.limit, MAX_JOB_LIMIT)
        : results.length;
      results = results.slice(offset, offset + limit);
    }
    return results.map((j) => ({ ...j }));
  }

  async listWithMeta(tenantId: string, options?: JobListOptions): Promise<JobListResult> {
    const totalRows = await this.findByTenant(tenantId, {
      ...options,
      limit: undefined,
      offset: undefined,
    });
    const data = await this.findByTenant(tenantId, options);
    return { data, total: totalRows.length };
  }

  async update(tenantId: string, id: string, updates: Partial<Job>): Promise<Job | null> {
    const j = this.jobs.get(id);
    if (!j || j.tenantId !== tenantId) return null;
    const updated = { ...j, ...updates };
    this.jobs.set(id, updated);
    return { ...updated };
  }

  async getNextJobNumber(tenantId: string): Promise<number> {
    const current = this.counters.get(tenantId) || 0;
    const next = current + 1;
    this.counters.set(tenantId, next);
    return next;
  }
}
