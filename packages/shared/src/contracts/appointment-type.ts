import { z } from 'zod';

/**
 * Canonical appointment-type taxonomy — the *kind* of visit being booked,
 * independent of the classifier intent and the free-text job summary.
 *
 * One shared set across every vertical (HVAC, plumbing, electrical, …): the
 * canonical vertical packs all reduce to these visit kinds. "Emergency" is
 * deliberately NOT a type — urgency is carried by the proposal trust tier /
 * `emergency_dispatch` intent, not the appointment taxonomy.
 *
 * Single source of truth: emitted (enum-validated) by the appointment task
 * (`packages/api/src/ai/tasks/create-appointment-task.ts`), carried on the
 * `create_appointment` proposal payload, and reconciled to the
 * `appointments.appointment_type` CHECK constraint in
 * `packages/api/src/db/schema.ts`.
 */
export const appointmentTypeSchema = z.enum([
  'estimate',
  'repair',
  'install',
  'maintenance',
  'diagnostic',
]);

export type AppointmentTypeValue = z.infer<typeof appointmentTypeSchema>;

/**
 * Ordered canonical list — convenient for UI option lists and for the
 * enum ↔ DB-CHECK parity assertion.
 */
export const APPOINTMENT_TYPES = appointmentTypeSchema.options;
