import { v4 as uuidv4 } from 'uuid';
import { AuditRepository, createAuditEvent } from '../audit/audit';

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
}

export interface JobRepository {
  create(job: Job): Promise<Job>;
  findById(tenantId: string, id: string): Promise<Job | null>;
  findByTenant(tenantId: string, options?: JobListOptions): Promise<Job[]>;
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
      actorRole: 'owner',
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
      actorRole: 'owner',
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
    return results.map((j) => ({ ...j }));
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
