import { v4 as uuidv4 } from 'uuid';
import { validateAppointmentTimes, validateAppointmentUpdateInput } from './validation';
import { assertValidAppointmentTransition } from './appointment-lifecycle';
import { isValidIanaTimezone } from '../settings/settings';
import { toUtcDate } from './time';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { AppointmentTypeValue } from '@ai-service-os/shared';

export type AppointmentStatus = 'scheduled' | 'confirmed' | 'in_progress' | 'completed' | 'canceled' | 'no_show';

export interface Appointment {
  id: string;
  tenantId: string;
  jobId: string;
  /** Persisted as a UTC instant. */
  scheduledStart: Date;
  /** Persisted as a UTC instant. */
  scheduledEnd: Date;
  /** Persisted as a UTC instant when present. */
  arrivalWindowStart?: Date;
  /** Persisted as a UTC instant when present. */
  arrivalWindowEnd?: Date;
  /**
   * Display/context timezone only (e.g., rendering and UX context).
   * This metadata does not affect persisted UTC instants.
   */
  timezone: string;
  status: AppointmentStatus;
  /**
   * When true, this appointment is a tentative AI-placed hold awaiting
   * owner approval. The slot is reserved on the calendar but not yet
   * confirmed. Cleared to false on approval; the appointment is
   * canceled on rejection.
   */
  holdPendingApproval: boolean;
  /** When the tentative hold auto-releases if not approved (set when holdPendingApproval is true). */
  holdExpiryAt?: Date;
  /**
   * Optional dedup key for at-least-once write paths (e.g. a redelivered
   * voice message). Unique per tenant via a partial index; when set, a
   * second create with the same key returns the existing appointment
   * instead of inserting a duplicate.
   *
   * Explicit `null` is a write-time signal to RELEASE the key (set the
   * column to SQL NULL) — used when an appointment is canceled so a later
   * write can reuse the same canonical key without deduping back into the
   * canceled row. Reads still surface `undefined` for an unset column.
   */
  idempotencyKey?: string | null;
  notes?: string;
  /**
   * Typed visit kind (estimate/repair/install/maintenance/diagnostic).
   * Optional — legacy rows and inbound-caller DRAFTs carry none.
   */
  appointmentType?: AppointmentTypeValue;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A tentative AI-placed hold has released its slot once its expiry passes —
 * the scheduling read paths (availability-finder, slot-conflict-checker)
 * treat such an appointment as free rather than as occupying the slot.
 * A live hold (expiry in the future) and any non-hold appointment still
 * occupy their slot. Shared so all readers apply identical semantics.
 */
export function isExpiredHold(
  appt: Pick<Appointment, 'holdPendingApproval' | 'holdExpiryAt'>,
  now: number,
): boolean {
  return Boolean(
    appt.holdPendingApproval && appt.holdExpiryAt && appt.holdExpiryAt.getTime() < now,
  );
}

export interface CreateAppointmentInput {
  tenantId: string;
  jobId: string;
  /** UTC/local instant provided by caller; persisted as a normalized UTC instant. */
  scheduledStart: Date;
  /** UTC/local instant provided by caller; persisted as a normalized UTC instant. */
  scheduledEnd: Date;
  /** UTC/local instant provided by caller; persisted as a normalized UTC instant. */
  arrivalWindowStart?: Date;
  /** UTC/local instant provided by caller; persisted as a normalized UTC instant. */
  arrivalWindowEnd?: Date;
  /** Display/context timezone only; time fields are persisted as UTC instants. */
  timezone: string;
  notes?: string;
  /** Typed visit kind emitted enum-validated by the appointment task. Optional. */
  appointmentType?: AppointmentTypeValue;
  /** Create the appointment as a tentative hold awaiting approval. Defaults to false. */
  holdPendingApproval?: boolean;
  /** When the tentative hold auto-releases. Set when holdPendingApproval is true. */
  holdExpiryAt?: Date;
  /** Optional dedup key for at-least-once writes; see Appointment.idempotencyKey. */
  idempotencyKey?: string;
  createdBy: string;
}

export interface UpdateAppointmentInput {
  scheduledStart?: Date;
  scheduledEnd?: Date;
  arrivalWindowStart?: Date;
  arrivalWindowEnd?: Date;
  /** Display/context timezone only; time fields are persisted as UTC instants. */
  timezone?: string;
  notes?: string;
  status?: AppointmentStatus;
  holdPendingApproval?: boolean;
  holdExpiryAt?: Date;
  /**
   * Pass `null` to release the dedup key (e.g. on cancel); `string` to set
   * it. The pg repo maps this onto the `idempotency_key` column.
   */
  idempotencyKey?: string | null;
}

export interface AppointmentListOptions {
  jobId?: string;
  technicianId?: string;
  status?: AppointmentStatus;
  /** Inclusive lower bound on `scheduled_start`. */
  fromDate?: Date;
  /** Inclusive upper bound on `scheduled_start`. */
  toDate?: Date;
  /** Pagination cap. Default 50, hard-capped server-side at 200. */
  limit?: number;
  /** Pagination offset. Default 0. */
  offset?: number;
  /** Sort direction applied to the canonical sort column (scheduled_start). */
  sort?: 'asc' | 'desc';
}

export interface AppointmentListResult {
  data: Appointment[];
  total: number;
}

export const DEFAULT_APPOINTMENT_LIMIT = 50;
export const MAX_APPOINTMENT_LIMIT = 200;

export interface AppointmentRepository {
  create(appointment: Appointment): Promise<Appointment>;
  findById(tenantId: string, id: string): Promise<Appointment | null>;
  findByJob(tenantId: string, jobId: string): Promise<Appointment[]>;
  findByDateRange(tenantId: string, start: Date, end: Date): Promise<Appointment[]>;
  /**
   * U6 — tentative holds whose `hold_expiry_at` has passed (and that are still
   * `hold_pending_approval`). Backs the hold-reaper sweep that cancels expired
   * holds so they stop polluting raw appointment reads. Pg uses the partial
   * index `idx_appointments_hold_expiry`.
   */
  findExpiredHolds(tenantId: string, now: Date): Promise<Appointment[]>;
  /**
   * P1-018: paginated `{ data, total }` form for list UIs. Filters by date
   * range / status / technician and supports optional `limit` / `offset`.
   * Optional so older repos still satisfy the type — falls back to in-memory
   * filtering through `findByDateRange`.
   */
  listWithMeta?(tenantId: string, options?: AppointmentListOptions): Promise<AppointmentListResult>;
  update(tenantId: string, id: string, updates: Partial<Appointment>): Promise<Appointment | null>;
}

export interface AppointmentWriteOptions {
  /**
   * Optional metadata channel for non-blocking validation warnings.
   * Write operations still succeed when warnings are present.
   */
  onValidationWarnings?: (warnings: string[]) => void;
}

export function validateAppointmentInput(input: CreateAppointmentInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.jobId) errors.push('jobId is required');
  if (!input.scheduledStart) errors.push('scheduledStart is required');
  if (!input.scheduledEnd) errors.push('scheduledEnd is required');
  if (!input.timezone) errors.push('timezone is required');
  if (input.timezone && !isValidIanaTimezone(input.timezone)) errors.push('Invalid timezone');
  if (!input.createdBy) errors.push('createdBy is required');
  return errors;
}

function normalizeAppointmentTimeUpdates(
  input: Pick<UpdateAppointmentInput, 'scheduledStart' | 'scheduledEnd' | 'arrivalWindowStart' | 'arrivalWindowEnd'>
): Pick<UpdateAppointmentInput, 'scheduledStart' | 'scheduledEnd' | 'arrivalWindowStart' | 'arrivalWindowEnd'> {
  const normalized: Pick<UpdateAppointmentInput, 'scheduledStart' | 'scheduledEnd' | 'arrivalWindowStart' | 'arrivalWindowEnd'> = {};

  if ('scheduledStart' in input) {
    normalized.scheduledStart = input.scheduledStart ? toUtcDate(input.scheduledStart) : undefined;
  }
  if ('scheduledEnd' in input) {
    normalized.scheduledEnd = input.scheduledEnd ? toUtcDate(input.scheduledEnd) : undefined;
  }
  if ('arrivalWindowStart' in input) {
    normalized.arrivalWindowStart = input.arrivalWindowStart ? toUtcDate(input.arrivalWindowStart) : undefined;
  }
  if ('arrivalWindowEnd' in input) {
    normalized.arrivalWindowEnd = input.arrivalWindowEnd ? toUtcDate(input.arrivalWindowEnd) : undefined;
  }

  return normalized;
}

export async function createAppointment(
  input: CreateAppointmentInput,
  repository: AppointmentRepository,
  options?: AppointmentWriteOptions,
  auditRepo?: AuditRepository,
  actorRole?: string,
): Promise<Appointment> {
  const errors = validateAppointmentInput(input);
  const timeValidation = validateAppointmentTimes(input);
  errors.push(...timeValidation.errors);
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);

  if (timeValidation.warnings.length > 0) {
    options?.onValidationWarnings?.(timeValidation.warnings);
  }

  const appointment: Appointment = {
    id: uuidv4(),
    tenantId: input.tenantId,
    jobId: input.jobId,
    scheduledStart: toUtcDate(input.scheduledStart),
    scheduledEnd: toUtcDate(input.scheduledEnd),
    arrivalWindowStart: input.arrivalWindowStart ? toUtcDate(input.arrivalWindowStart) : undefined,
    arrivalWindowEnd: input.arrivalWindowEnd ? toUtcDate(input.arrivalWindowEnd) : undefined,
    timezone: input.timezone,
    status: 'scheduled',
    holdPendingApproval: input.holdPendingApproval ?? false,
    holdExpiryAt: input.holdExpiryAt,
    idempotencyKey: input.idempotencyKey,
    notes: input.notes,
    appointmentType: input.appointmentType,
    createdBy: input.createdBy,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Warnings are non-blocking for writes; we emit them to logs as an optional metadata channel.
  if (timeValidation.warnings.length > 0) {
    console.warn(`Appointment validation warnings on create: ${timeValidation.warnings.join(', ')}`);
  }

  const created = await repository.create(appointment);

  // On an idempotency-key dedup hit the repo returns a pre-existing row
  // (different id than the one we generated) without inserting — don't emit
  // a second `appointment.created` audit event for an appointment we didn't
  // actually create.
  const wasDeduped = created.id !== appointment.id;

  if (auditRepo && !wasDeduped) {
    const event = createAuditEvent({
      tenantId: input.tenantId,
      actorId: input.createdBy,
      actorRole: actorRole ?? 'unknown',
      eventType: 'appointment.created',
      entityType: 'appointment',
      entityId: created.id,
      metadata: { jobId: created.jobId },
    });
    await auditRepo.create(event);
  }

  return created;
}

export async function getAppointment(
  tenantId: string,
  id: string,
  repository: AppointmentRepository
): Promise<Appointment | null> {
  return repository.findById(tenantId, id);
}

export async function updateAppointment(
  tenantId: string,
  id: string,
  input: UpdateAppointmentInput,
  repository: AppointmentRepository,
  options?: AppointmentWriteOptions,
  auditRepo?: AuditRepository,
  actorId?: string,
  actorRole?: string,
): Promise<Appointment | null> {
  if (input.timezone && !isValidIanaTimezone(input.timezone)) {
    throw new Error('Validation failed: Invalid timezone');
  }

  const existing = await repository.findById(tenantId, id);
  if (!existing) return null;

  const errors: string[] = [];
  if (input.timezone && !isValidIanaTimezone(input.timezone)) errors.push('Invalid timezone');
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);

  const validation = validateAppointmentUpdateInput(existing, input);
  if (validation.errors.length > 0) throw new Error(`Validation failed: ${validation.errors.join(', ')}`);

  // Status lifecycle enforcement. When a status is supplied AND differs
  // from the persisted value, ensure the transition is in the allowed set
  // (e.g. `completed` is terminal — nothing transitions out of it). The
  // helper accepts self-transitions so proposal-execution dedup that
  // replays the same status update isn't rejected as a 400.
  if (input.status !== undefined) {
    assertValidAppointmentTransition(existing.status, input.status);
  }

  const normalizedTimes = normalizeAppointmentTimeUpdates(input);
  const updated = await repository.update(tenantId, id, {
    ...input,
    ...normalizedTimes,
    updatedAt: new Date(),
  });

  if (auditRepo && actorId && updated) {
    const event = createAuditEvent({
      tenantId,
      actorId,
      actorRole: actorRole ?? 'unknown',
      eventType: 'appointment.updated',
      entityType: 'appointment',
      entityId: id,
      metadata: { changes: Object.keys(input) },
    });
    await auditRepo.create(event);

    // Emit a dedicated `appointment.status_changed` event when the status
    // actually moved (skip on self-transition or when status wasn't in the
    // patch). Downstream observers — dispatch dashboards, analytics —
    // subscribe to the specific event type rather than scanning every
    // generic `appointment.updated` payload.
    if (input.status !== undefined && input.status !== existing.status) {
      const statusEvent = createAuditEvent({
        tenantId,
        actorId,
        actorRole: actorRole ?? 'unknown',
        eventType: 'appointment.status_changed',
        entityType: 'appointment',
        entityId: id,
        metadata: { from: existing.status, to: input.status },
      });
      await auditRepo.create(statusEvent);
    }
  }

  return updated;
}

export async function listByJob(
  tenantId: string,
  jobId: string,
  repository: AppointmentRepository
): Promise<Appointment[]> {
  return repository.findByJob(tenantId, jobId);
}

export async function listByDateRange(
  tenantId: string,
  start: Date,
  end: Date,
  repository: AppointmentRepository
): Promise<Appointment[]> {
  return repository.findByDateRange(tenantId, start, end);
}

/**
 * P1-018: paginated appointment list with `{ data, total }`. Falls back to
 * a default-wide date range when the repo doesn't expose `listWithMeta`.
 */
export async function listAppointmentsWithMeta(
  tenantId: string,
  repository: AppointmentRepository,
  options?: AppointmentListOptions
): Promise<AppointmentListResult> {
  if (repository.listWithMeta) {
    return repository.listWithMeta(tenantId, options);
  }
  // Fallback path: pull a date-range slice and apply remaining filters in
  // memory. This is only used by repositories that haven't implemented
  // `listWithMeta` yet (P1-018 ships it for InMemory + Pg).
  const start = options?.fromDate ?? new Date('1970-01-01T00:00:00Z');
  const end = options?.toDate ?? new Date('9999-12-31T23:59:59Z');
  const all = await repository.findByDateRange(tenantId, start, end);
  let filtered = all;
  if (options?.jobId) filtered = filtered.filter((a) => a.jobId === options.jobId);
  if (options?.status) filtered = filtered.filter((a) => a.status === options.status);
  const sortDir = options?.sort === 'desc' ? -1 : 1;
  filtered.sort((a, b) => sortDir * (a.scheduledStart.getTime() - b.scheduledStart.getTime()));
  const limit = Math.min(options?.limit ?? DEFAULT_APPOINTMENT_LIMIT, MAX_APPOINTMENT_LIMIT);
  const offset = options?.offset ?? 0;
  return { data: filtered.slice(offset, offset + limit), total: filtered.length };
}

// VQ-002 — InMemoryAppointmentRepository moved to ./in-memory-appointment.ts
// so the in-memory and Pg variants are symmetric (each in its own file).
// Re-exported here so existing callers that import from './appointment'
// continue to compile.
export { InMemoryAppointmentRepository } from './in-memory-appointment';
