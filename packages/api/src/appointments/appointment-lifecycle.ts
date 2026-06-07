import { AppointmentStatus } from './appointment';
import { ValidationError } from '../shared/errors';

/**
 * Allowed transitions between appointment statuses.
 *
 * The map mirrors the real-world flow:
 *
 *   scheduled    → confirmed | in_progress | canceled | no_show
 *   confirmed    → scheduled | in_progress | canceled | no_show
 *   in_progress  → completed | canceled
 *   completed    →   (terminal — completed work is closed)
 *   canceled     →   (terminal — re-engaging means creating a new appointment)
 *   no_show      → scheduled
 *
 * Notes:
 *
 *  - `confirmed → scheduled` is allowed so a confirmation that turns out to
 *    be wrong (e.g. customer asks to push, dispatcher revokes confirmation)
 *    can step back without forcing a cancel.
 *  - `no_show → scheduled` is the "reschedule a missed appointment" path —
 *    the customer didn't show, dispatcher reopens the slot for a new time.
 *  - Self-transitions (X → X) are accepted as no-ops by
 *    `isValidAppointmentTransition`. Proposal-execution dedup can replay
 *    the same status update; treating it as valid avoids a 400 from a
 *    benign retry.
 *
 * The DB CHECK on `appointments.status` enumerates the same values; if a
 * new status is ever added to the enum it must be reflected here too.
 */
export const VALID_APPOINTMENT_TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  scheduled: ['confirmed', 'in_progress', 'canceled', 'no_show'],
  confirmed: ['scheduled', 'in_progress', 'canceled', 'no_show'],
  in_progress: ['completed', 'canceled'],
  completed: [],
  canceled: [],
  no_show: ['scheduled'],
};

/**
 * Returns true if `from → to` is allowed by the appointment lifecycle.
 * Same-status transitions are always accepted (treated as a no-op).
 */
export function isValidAppointmentTransition(
  from: AppointmentStatus,
  to: AppointmentStatus,
): boolean {
  if (from === to) return true;
  return VALID_APPOINTMENT_TRANSITIONS[from].includes(to);
}

/**
 * Throws ValidationError (400) when `from → to` is not allowed. The error
 * message names both sides so the caller (and any client) can build a
 * descriptive UI without re-deriving the rules.
 */
export function assertValidAppointmentTransition(
  from: AppointmentStatus,
  to: AppointmentStatus,
): void {
  if (isValidAppointmentTransition(from, to)) return;
  const allowed = VALID_APPOINTMENT_TRANSITIONS[from];
  const allowedDesc = allowed.length === 0 ? '<terminal state>' : allowed.join(', ');
  throw new ValidationError(
    `Invalid appointment status transition: ${from} → ${to}. Allowed from ${from}: ${allowedDesc}.`,
  );
}

/** Terminal statuses cannot be transitioned out of. */
export function isTerminalAppointmentStatus(status: AppointmentStatus): boolean {
  return VALID_APPOINTMENT_TRANSITIONS[status].length === 0;
}
