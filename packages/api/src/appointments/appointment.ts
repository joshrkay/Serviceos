import { v4 as uuidv4 } from 'uuid';
import { validateAppointmentTimes } from './validation';

export type AppointmentStatus = 'scheduled' | 'confirmed' | 'in_progress' | 'completed' | 'canceled' | 'no_show';

export interface Appointment {
  id: string;
  tenantId: string;
  jobId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  arrivalWindowStart?: Date;
  arrivalWindowEnd?: Date;
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
  timezone: string;
  notes?: string;
  createdBy: string;
}

export interface UpdateAppointmentInput {
  scheduledStart?: Date;
  scheduledEnd?: Date;
  arrivalWindowStart?: Date;
  arrivalWindowEnd?: Date;
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
  if (!input.createdBy) errors.push('createdBy is required');
  return errors;
}

export async function createAppointment(
  input: CreateAppointmentInput,
  repository: AppointmentRepository,
  options?: AppointmentWriteOptions
): Promise<Appointment> {
  const errors = validateAppointmentInput(input);
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);

  const timeValidation = validateAppointmentTimes(input);
  if (timeValidation.errors.length > 0) {
    throw new Error(`Validation failed: ${timeValidation.errors.join('; ')}`);
  }
  if (timeValidation.warnings.length > 0) {
    options?.onValidationWarnings?.(timeValidation.warnings);
  }

  const appointment: Appointment = {
    id: uuidv4(),
    tenantId: input.tenantId,
    jobId: input.jobId,
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd,
    arrivalWindowStart: input.arrivalWindowStart,
    arrivalWindowEnd: input.arrivalWindowEnd,
    timezone: input.timezone,
    status: 'scheduled',
    notes: input.notes,
    createdBy: input.createdBy,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

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
  const existing = await repository.findById(tenantId, id);
  if (!existing) return null;

  const effectiveSchedule = {
    scheduledStart: input.scheduledStart ?? existing.scheduledStart,
    scheduledEnd: input.scheduledEnd ?? existing.scheduledEnd,
    arrivalWindowStart: input.arrivalWindowStart ?? existing.arrivalWindowStart,
    arrivalWindowEnd: input.arrivalWindowEnd ?? existing.arrivalWindowEnd,
  };

  const timeValidation = validateAppointmentTimes(effectiveSchedule);
  if (timeValidation.errors.length > 0) {
    throw new Error(`Validation failed: ${timeValidation.errors.join('; ')}`);
  }
  if (timeValidation.warnings.length > 0) {
    options?.onValidationWarnings?.(timeValidation.warnings);
  }

  return repository.update(tenantId, id, { ...input, updatedAt: new Date() });
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
