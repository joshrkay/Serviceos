import { v4 as uuidv4 } from 'uuid';
import { APPOINTMENT_TYPES, AppointmentTypeValue } from '@ai-service-os/shared';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { ConflictError, NotFoundError, ValidationError } from '../shared/errors';
import {
  RecurrenceRule,
  computeOccurrences,
  describeRecurrence,
  isValidDateString,
  validateRecurrenceRule,
} from './recurrence';

/** 24-hour 'HH:MM' local time-of-day for the visit. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export function isValidTimeOfDay(value: unknown): value is string {
  return typeof value === 'string' && TIME_RE.test(value);
}

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
  /** Local time-of-day ('HH:MM', tenant timezone) each visit starts. */
  anchorTime: string;
  /** Visit length in minutes; with anchorTime it sizes the materialized appointment. */
  durationMinutes: number;
  /** Visit kind stamped on generated appointments; null = unspecified. */
  appointmentType: AppointmentTypeValue | null;
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
  anchorTime?: string;
  durationMinutes?: number;
  appointmentType?: AppointmentTypeValue | null;
  rule: RecurrenceRule;
  notes?: string | null;
  createdBy: string;
  actorRole?: string;
}

export interface UpdateRecurringJobInput {
  title?: string;
  anchorDate?: string;
  anchorTime?: string;
  durationMinutes?: number;
  appointmentType?: AppointmentTypeValue | null;
  rule?: RecurrenceRule;
  notes?: string | null;
}

/** A materialization ledger row: which occurrence dates became real visits. */
export interface RecurringJobOccurrence {
  id: string;
  tenantId: string;
  recurringJobId: string;
  occurrenceDate: string;
  jobId: string | null;
  appointmentId: string | null;
}

export interface RecurringJobRepository {
  create(job: RecurringJob): Promise<RecurringJob>;
  findById(tenantId: string, id: string): Promise<RecurringJob | null>;
  list(tenantId: string, opts?: { customerId?: string; includeArchived?: boolean }): Promise<RecurringJob[]>;
  update(job: RecurringJob): Promise<RecurringJob>;
  archive(tenantId: string, id: string): Promise<RecurringJob | null>;

  /**
   * Atomically claim an occurrence date for materialization. Returns a new
   * ledger id if this caller won the claim, or null if the date was already
   * claimed (idempotency: the UNIQUE(tenant, series, date) guarantees one
   * visit per occurrence even under concurrent generation).
   */
  claimOccurrence(tenantId: string, recurringJobId: string, occurrenceDate: string): Promise<string | null>;
  /** Link a claimed ledger row to the job + appointment it produced. */
  linkOccurrence(tenantId: string, ledgerId: string, jobId: string, appointmentId: string): Promise<void>;
  /**
   * Release a claimed-but-unlinked ledger row (delete it) so a later run can
   * retry that occurrence. Called when visit creation fails after the claim, so
   * a transient error doesn't permanently mark the date materialized and skip
   * it forever. Never deletes a row that already produced a visit (job_id set).
   */
  releaseOccurrence(tenantId: string, ledgerId: string): Promise<void>;
  /** Occurrence dates already materialized for a series (for preview/skip). */
  listMaterializedDates(tenantId: string, recurringJobId: string): Promise<string[]>;
}

export function validateRecurringJobInput(input: {
  title?: string;
  customerId?: string;
  anchorDate?: string;
  anchorTime?: string;
  durationMinutes?: number;
  appointmentType?: AppointmentTypeValue | null;
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
  if (input.anchorTime !== undefined && !isValidTimeOfDay(input.anchorTime)) {
    errors.push('anchorTime must be HH:MM (24-hour)');
  }
  if (input.durationMinutes !== undefined) {
    if (
      typeof input.durationMinutes !== 'number' ||
      !Number.isInteger(input.durationMinutes) ||
      input.durationMinutes < 15 ||
      input.durationMinutes > 480
    ) {
      errors.push('durationMinutes must be an integer between 15 and 480');
    }
  }
  if (
    input.appointmentType !== undefined &&
    input.appointmentType !== null &&
    !APPOINTMENT_TYPES.includes(input.appointmentType as AppointmentTypeValue)
  ) {
    errors.push('invalid appointmentType');
  }
  return errors;
}

/**
 * Upcoming occurrence dates for a series. `from` (default = anchor) filters out
 * past dates; `limit` caps the count. Returns 'YYYY-MM-DD' strings ascending.
 */
export function upcomingOccurrences(job: RecurringJob, from: string | undefined, limit: number): string[] {
  if (limit <= 0) return [];
  const start = from && isValidDateString(from) ? from : undefined;
  // Grow the computed window until we have `limit` dates at/after `from`, or the
  // rule is exhausted (window shorter than the cap = a bounded count/until
  // series ran out). A fixed window would under-fill for a long-running series
  // anchored far before `from` — e.g. a daily series anchored 90 days back with
  // limit=3 has all its early dates filtered out and returns nothing.
  let cap = Math.max(limit * 4, limit + 50);
  const HARD_CAP = 20_000;
  for (;;) {
    const window = computeOccurrences(job.anchorDate, job.rule, cap);
    const filtered = start ? window.filter((d) => d >= start) : window;
    if (filtered.length >= limit || window.length < cap || cap >= HARD_CAP) {
      return filtered.slice(0, limit);
    }
    cap = Math.min(cap * 2, HARD_CAP);
  }
}

export async function createRecurringJob(
  input: CreateRecurringJobInput,
  repository: RecurringJobRepository,
  auditRepo?: AuditRepository
): Promise<RecurringJob> {
  const errors = validateRecurringJobInput(input);
  if (errors.length > 0) throw new ValidationError(`Validation failed: ${errors.join(', ')}`);

  const now = new Date();
  const job: RecurringJob = {
    id: uuidv4(),
    tenantId: input.tenantId,
    customerId: input.customerId,
    title: input.title.trim(),
    anchorDate: input.anchorDate,
    anchorTime: input.anchorTime ?? '09:00',
    durationMinutes: input.durationMinutes ?? 60,
    appointmentType: input.appointmentType ?? 'maintenance',
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
  if (!existing) throw new NotFoundError('Recurring job', id);

  const merged = {
    title: input.title ?? existing.title,
    customerId: existing.customerId,
    anchorDate: input.anchorDate ?? existing.anchorDate,
    anchorTime: input.anchorTime ?? existing.anchorTime,
    durationMinutes: input.durationMinutes ?? existing.durationMinutes,
    appointmentType: input.appointmentType !== undefined ? input.appointmentType : existing.appointmentType,
    rule: input.rule ?? existing.rule,
  };
  const errors = validateRecurringJobInput(merged);
  if (errors.length > 0) throw new ValidationError(`Validation failed: ${errors.join(', ')}`);

  const updated: RecurringJob = {
    ...existing,
    title: merged.title.trim(),
    anchorDate: merged.anchorDate,
    anchorTime: merged.anchorTime,
    durationMinutes: merged.durationMinutes,
    appointmentType: merged.appointmentType,
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
  private occurrences: RecurringJobOccurrence[] = [];

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

  async claimOccurrence(
    tenantId: string,
    recurringJobId: string,
    occurrenceDate: string
  ): Promise<string | null> {
    const exists = this.occurrences.some(
      (o) =>
        o.tenantId === tenantId &&
        o.recurringJobId === recurringJobId &&
        o.occurrenceDate === occurrenceDate
    );
    if (exists) return null;
    const id = uuidv4();
    this.occurrences.push({
      id,
      tenantId,
      recurringJobId,
      occurrenceDate,
      jobId: null,
      appointmentId: null,
    });
    return id;
  }

  async linkOccurrence(
    tenantId: string,
    ledgerId: string,
    jobId: string,
    appointmentId: string
  ): Promise<void> {
    const row = this.occurrences.find((o) => o.id === ledgerId && o.tenantId === tenantId);
    if (row) {
      row.jobId = jobId;
      row.appointmentId = appointmentId;
    }
  }

  async releaseOccurrence(tenantId: string, ledgerId: string): Promise<void> {
    this.occurrences = this.occurrences.filter(
      (o) => !(o.id === ledgerId && o.tenantId === tenantId && o.jobId === null)
    );
  }

  async listMaterializedDates(tenantId: string, recurringJobId: string): Promise<string[]> {
    return this.occurrences
      .filter((o) => o.tenantId === tenantId && o.recurringJobId === recurringJobId)
      .map((o) => o.occurrenceDate)
      .sort();
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (key, v) =>
    (key === 'createdAt' || key === 'updatedAt') && typeof v === 'string' ? new Date(v) : v
  );
}
