import { CreateAppointmentInput, UpdateAppointmentInput } from './appointment';

export interface AppointmentValidationResult {
  errors: string[];
  warnings: string[];
}

const MAX_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

export function validateAppointmentTimes(
  input: CreateAppointmentInput | {
    scheduledStart: Date;
    scheduledEnd: Date;
    arrivalWindowStart?: Date;
    arrivalWindowEnd?: Date;
  }
): AppointmentValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const { scheduledStart, scheduledEnd, arrivalWindowStart, arrivalWindowEnd } = input;

  // Scheduled time ordering
  if (scheduledStart && scheduledEnd) {
    if (scheduledStart >= scheduledEnd) {
      errors.push('scheduledStart must be before scheduledEnd');
    }

    // Duration sanity check
    const duration = scheduledEnd.getTime() - scheduledStart.getTime();
    if (duration > MAX_DURATION_MS) {
      errors.push('Appointment duration cannot exceed 24 hours');
    }
  }

  // Arrival window: both or neither
  const hasArrivalStart = arrivalWindowStart !== undefined && arrivalWindowStart !== null;
  const hasArrivalEnd = arrivalWindowEnd !== undefined && arrivalWindowEnd !== null;

  if (hasArrivalStart !== hasArrivalEnd) {
    errors.push('Both arrivalWindowStart and arrivalWindowEnd must be provided together');
  }

  // Arrival window ordering
  if (hasArrivalStart && hasArrivalEnd) {
    if (arrivalWindowStart! >= arrivalWindowEnd!) {
      errors.push('arrivalWindowStart must be before arrivalWindowEnd');
    }

    // Arrival window should encompass scheduled start
    if (scheduledStart && arrivalWindowStart! > scheduledStart) {
      errors.push('arrivalWindowStart must be at or before scheduledStart');
    }
  }

  // Past scheduling warning
  if (scheduledStart && scheduledStart < new Date()) {
    warnings.push('Appointment is scheduled in the past');
  }

  return { errors, warnings };
}
