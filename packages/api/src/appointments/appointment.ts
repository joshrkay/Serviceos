import { v4 as uuidv4 } from 'uuid';
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
  scheduledStart: Date;
  scheduledEnd: Date;
  arrivalWindowStart?: Date;
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

export async function createAppointment(
  input: CreateAppointmentInput,
  repository: AppointmentRepository
): Promise<Appointment> {
  const errors = validateAppointmentInput(input);
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);

  const timeValidation = validateAppointmentTimes(input);
  if (timeValidation.errors.length > 0) {
    throw new Error(`Validation failed: ${timeValidation.errors.join(', ')}`);
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
  repository: AppointmentRepository
): Promise<Appointment | null> {
  const updates: Partial<Appointment> = {
    ...input,
    updatedAt: new Date(),
  };

  if (input.scheduledStart) updates.scheduledStart = toUtcDate(input.scheduledStart);
  if (input.scheduledEnd) updates.scheduledEnd = toUtcDate(input.scheduledEnd);
  if (input.arrivalWindowStart) updates.arrivalWindowStart = toUtcDate(input.arrivalWindowStart);
  if (input.arrivalWindowEnd) updates.arrivalWindowEnd = toUtcDate(input.arrivalWindowEnd);

  if (input.timezone && !VALID_TIMEZONES.includes(input.timezone)) {
    throw new Error('Validation failed: Invalid timezone');
  }

  return repository.update(tenantId, id, updates);
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
