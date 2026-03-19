import { v4 as uuidv4 } from 'uuid';
import { validateAppointmentTimes, validateAppointmentUpdateInput } from './validation';
import { VALID_TIMEZONES } from '../settings/settings';
import { toUtcDate } from './time';

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
  notes?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
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
}

export interface AppointmentRepository {
  create(appointment: Appointment): Promise<Appointment>;
  findById(tenantId: string, id: string): Promise<Appointment | null>;
  findByJob(tenantId: string, jobId: string): Promise<Appointment[]>;
  findByDateRange(tenantId: string, start: Date, end: Date): Promise<Appointment[]>;
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
  if (input.timezone && !VALID_TIMEZONES.includes(input.timezone)) errors.push('Invalid timezone');
  if (!input.createdBy) errors.push('createdBy is required');
  return errors;
}

function normalizeAppointmentTimeUpdates(
  input: Pick<UpdateAppointmentInput, 'scheduledStart' | 'scheduledEnd' | 'arrivalWindowStart' | 'arrivalWindowEnd'>
): Pick<UpdateAppointmentInput, 'scheduledStart' | 'scheduledEnd' | 'arrivalWindowStart' | 'arrivalWindowEnd'> {
  const normalized: Pick<UpdateAppointmentInput, 'scheduledStart' | 'scheduledEnd' | 'arrivalWindowStart' | 'arrivalWindowEnd'> = {};

  if ('scheduledStart' in input && input.scheduledStart) normalized.scheduledStart = toUtcDate(input.scheduledStart);
  if ('scheduledEnd' in input && input.scheduledEnd) normalized.scheduledEnd = toUtcDate(input.scheduledEnd);
  if ('arrivalWindowStart' in input && input.arrivalWindowStart) normalized.arrivalWindowStart = toUtcDate(input.arrivalWindowStart);
  if ('arrivalWindowEnd' in input && input.arrivalWindowEnd) normalized.arrivalWindowEnd = toUtcDate(input.arrivalWindowEnd);

  return normalized;
}

export async function createAppointment(
  input: CreateAppointmentInput,
  repository: AppointmentRepository,
  options?: AppointmentWriteOptions
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
    notes: input.notes,
    createdBy: input.createdBy,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Warnings are non-blocking for writes; we emit them to logs as an optional metadata channel.
  if (timeValidation.warnings.length > 0) {
    console.warn(`Appointment validation warnings on create: ${timeValidation.warnings.join(', ')}`);
  }

  return repository.create(appointment);
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
  options?: AppointmentWriteOptions
): Promise<Appointment | null> {
  if (input.timezone && !isValidTimezone(input.timezone)) {
    throw new Error('Validation failed: Invalid timezone');
  }

  const existing = await repository.findById(tenantId, id);
  if (!existing) return null;

  const errors: string[] = [];
  if (input.timezone && !VALID_TIMEZONES.includes(input.timezone)) errors.push('Invalid timezone');
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);

  const validation = validateAppointmentUpdateInput(existing, input);
  if (validation.errors.length > 0) throw new Error(`Validation failed: ${validation.errors.join(', ')}`);

  const normalizedTimes = normalizeAppointmentTimeUpdates(input);
  return repository.update(tenantId, id, { ...input, ...normalizedTimes, updatedAt: new Date() });
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

export class InMemoryAppointmentRepository implements AppointmentRepository {
  private appointments: Map<string, Appointment> = new Map();

  async create(appointment: Appointment): Promise<Appointment> {
    this.appointments.set(appointment.id, { ...appointment });
    return { ...appointment };
  }

  async findById(tenantId: string, id: string): Promise<Appointment | null> {
    const a = this.appointments.get(id);
    if (!a || a.tenantId !== tenantId) return null;
    return { ...a };
  }

  async findByJob(tenantId: string, jobId: string): Promise<Appointment[]> {
    return Array.from(this.appointments.values())
      .filter((a) => a.tenantId === tenantId && a.jobId === jobId)
      .map((a) => ({ ...a }));
  }

  async findByDateRange(tenantId: string, start: Date, end: Date): Promise<Appointment[]> {
    return Array.from(this.appointments.values())
      .filter(
        (a) =>
          a.tenantId === tenantId &&
          a.scheduledStart >= start &&
          a.scheduledStart <= end
      )
      .map((a) => ({ ...a }));
  }

  async update(tenantId: string, id: string, updates: Partial<Appointment>): Promise<Appointment | null> {
    const a = this.appointments.get(id);
    if (!a || a.tenantId !== tenantId) return null;
    const updated = { ...a, ...updates };
    this.appointments.set(id, updated);
    return { ...updated };
  }
}
