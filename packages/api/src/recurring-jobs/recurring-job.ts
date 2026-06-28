import { v4 as uuidv4 } from 'uuid';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import {
  RecurrenceRule,
  computeOccurrences,
  describeRecurrence,
  isValidDateString,
  validateRecurrenceRule,
} from './recurrence';

/**
 * R-JOB (Jobber parity) — recurring job series.
 *
 * A tenant-defined recurring job for a customer (e.g. "Monthly HVAC filter
 * change for the Smiths"). Stores the customer, a title, an anchor date, and a
 * recurrence rule; upcoming visit dates are computed on demand from the rule
 * (see recurrence.ts). Materializing each occurrence into a real job +
 * appointment is a follow-up; this models the schedule itself.
 *
 * Mirrors the customer custom-field domain shape (port + pure functions +
 * in-memory repo); Pg impl in pg-recurring-job.ts.
 */

export interface RecurringJob {
  id: string;
  tenantId: string;
  customerId: string;
  title: string;
  /** First service date ('YYYY-MM-DD'); the recurrence is anchored here. */
  anchorDate: string;
  rule: RecurrenceRule;
  notes: string | null;
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRecurringJobInput {
  tenantId: string;
  customerId: string;
  title: string;
  anchorDate: string;
  rule: RecurrenceRule;
  notes?: string | null;
  createdBy: string;
  actorRole?: string;
}

export interface UpdateRecurringJobInput {
  title?: string;
  anchorDate?: string;
  rule?: RecurrenceRule;
  notes?: string | null;
}

export interface RecurringJobRepository {
  create(job: RecurringJob): Promise<RecurringJob>;
  findById(tenantId: string, id: string): Promise<RecurringJob | null>;
  list(tenantId: string, opts?: { customerId?: string; includeArchived?: boolean }): Promise<RecurringJob[]>;
  update(job: RecurringJob): Promise<RecurringJob>;
  archive(tenantId: string, id: string): Promise<RecurringJob | null>;
}

export function validateRecurringJobInput(input: {
  title?: string;
  customerId?: string;
  anchorDate?: string;
  rule?: Parameters<typeof validateRecurrenceRule>[0];
}): string[] {
  const errors: string[] = [];
  if (!input.title || !input.title.trim()) errors.push('title is required');
  if (!input.customerId) errors.push('customerId is required');
  if (!input.anchorDate || !isValidDateString(input.anchorDate)) {
    errors.push('anchorDate must be a date (YYYY-MM-DD)');
  }
  if (!input.rule) errors.push('rule is required');
  else errors.push(...validateRecurrenceRule(input.rule));
  return errors;
}

/**
 * Upcoming occurrence dates for a series. `from` (default = anchor) filters out
 * past dates; `limit` caps the count. Returns 'YYYY-MM-DD' strings ascending.
 */
export function upcomingOccurrences(job: RecurringJob, from: string | undefined, limit: number): string[] {
  // Generate a generous window from the anchor, then filter to `from` so a
  // count-bounded rule still reports the right remaining visits.
  const window = computeOccurrences(job.anchorDate, job.rule, Math.max(limit * 4, limit + 50));
  const filtered = from && isValidDateString(from) ? window.filter((d) => d >= from) : window;
  return filtered.slice(0, limit);
}

export async function createRecurringJob(
  input: CreateRecurringJobInput,
  repository: RecurringJobRepository,
  auditRepo?: AuditRepository
): Promise<RecurringJob> {
  const errors = validateRecurringJobInput(input);
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);

  const now = new Date();
  const job: RecurringJob = {
    id: uuidv4(),
    tenantId: input.tenantId,
    customerId: input.customerId,
    title: input.title.trim(),
    anchorDate: input.anchorDate,
    rule: normalizeRule(input.rule),
    notes: input.notes?.trim() || null,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  };
  const created = await repository.create(job);

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.createdBy,
        actorRole: input.actorRole ?? 'unknown',
        eventType: 'recurring_job.created',
        entityType: 'recurring_job',
        entityId: created.id,
        metadata: {
          customerId: created.customerId,
          schedule: describeRecurrence(created.rule),
        },
      })
    );
  }
  return created;
}

export async function updateRecurringJob(
  tenantId: string,
  id: string,
  input: UpdateRecurringJobInput,
  repository: RecurringJobRepository,
  actorId?: string,
  auditRepo?: AuditRepository,
  actorRole?: string
): Promise<RecurringJob> {
  const existing = await repository.findById(tenantId, id);
  if (!existing) throw new Error('Recurring job not found');

  const merged = {
    title: input.title ?? existing.title,
    customerId: existing.customerId,
    anchorDate: input.anchorDate ?? existing.anchorDate,
    rule: input.rule ?? existing.rule,
  };
  const errors = validateRecurringJobInput(merged);
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);

  const updated: RecurringJob = {
    ...existing,
    title: merged.title.trim(),
    anchorDate: merged.anchorDate,
    rule: normalizeRule(merged.rule),
    notes: input.notes !== undefined ? input.notes?.trim() || null : existing.notes,
    updatedAt: new Date(),
  };
  const saved = await repository.update(updated);

  if (auditRepo && actorId) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: actorRole ?? 'unknown',
        eventType: 'recurring_job.updated',
        entityType: 'recurring_job',
        entityId: saved.id,
        metadata: { schedule: describeRecurrence(saved.rule) },
      })
    );
  }
  return saved;
}

export async function archiveRecurringJob(
  tenantId: string,
  id: string,
  repository: RecurringJobRepository,
  actorId?: string,
  auditRepo?: AuditRepository,
  actorRole?: string
): Promise<RecurringJob | null> {
  const archived = await repository.archive(tenantId, id);
  if (archived && auditRepo && actorId) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: actorRole ?? 'unknown',
        eventType: 'recurring_job.archived',
        entityType: 'recurring_job',
        entityId: archived.id,
        metadata: { title: archived.title },
      })
    );
  }
  return archived;
}

function normalizeRule(rule: RecurrenceRule): RecurrenceRule {
  const normalized: RecurrenceRule = {
    frequency: rule.frequency,
    interval: rule.interval ?? 1,
  };
  if (rule.count !== undefined) normalized.count = rule.count;
  if (rule.until !== undefined) normalized.until = rule.until;
  return normalized;
}

export class InMemoryRecurringJobRepository implements RecurringJobRepository {
  private jobs: Map<string, RecurringJob> = new Map();

  async create(job: RecurringJob): Promise<RecurringJob> {
    this.jobs.set(job.id, clone(job));
    return clone(job);
  }

  async findById(tenantId: string, id: string): Promise<RecurringJob | null> {
    const j = this.jobs.get(id);
    if (!j || j.tenantId !== tenantId) return null;
    return clone(j);
  }

  async list(
    tenantId: string,
    opts: { customerId?: string; includeArchived?: boolean } = {}
  ): Promise<RecurringJob[]> {
    return Array.from(this.jobs.values())
      .filter(
        (j) =>
          j.tenantId === tenantId &&
          (opts.includeArchived || !j.isArchived) &&
          (!opts.customerId || j.customerId === opts.customerId)
      )
      .sort((a, b) => a.anchorDate.localeCompare(b.anchorDate) || a.title.localeCompare(b.title))
      .map(clone);
  }

  async update(job: RecurringJob): Promise<RecurringJob> {
    this.jobs.set(job.id, clone(job));
    return clone(job);
  }

  async archive(tenantId: string, id: string): Promise<RecurringJob | null> {
    const j = this.jobs.get(id);
    if (!j || j.tenantId !== tenantId) return null;
    const updated = { ...j, isArchived: true, updatedAt: new Date() };
    this.jobs.set(id, updated);
    return clone(updated);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (key, v) =>
    (key === 'createdAt' || key === 'updatedAt') && typeof v === 'string' ? new Date(v) : v
  );
}
