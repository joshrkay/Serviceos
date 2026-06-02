import { z } from 'zod';

/**
 * Canonical entity status value sets — the single source of truth, defined once
 * as Zod enums and reconciled to the database CHECK constraints in
 * `packages/api/src/db/schema.ts`.
 *
 * These exist so api and web stop hand-redeclaring (and silently disagreeing on)
 * status values. The legacy TS enums in `../enums.ts` are kept value-for-value in
 * lockstep with these sets, and `status.test.ts` asserts both that the legacy
 * enums match these schemas AND that each set exactly equals the corresponding
 * `CHECK (status IN (...))` constraint in `schema.ts`. A future drift — like the
 * historical jobs `created` vs DB `new` mismatch this work fixed — fails CI
 * instead of shipping.
 */

export const jobStatusSchema = z.enum([
  'new',
  'scheduled',
  'in_progress',
  'completed',
  'canceled',
]);
export type JobStatusValue = z.infer<typeof jobStatusSchema>;

export const appointmentStatusSchema = z.enum([
  'scheduled',
  'confirmed',
  'in_progress',
  'completed',
  'canceled',
  'no_show',
]);
export type AppointmentStatusValue = z.infer<typeof appointmentStatusSchema>;

export const estimateStatusSchema = z.enum([
  'draft',
  'ready_for_review',
  'sent',
  'accepted',
  'rejected',
  'expired',
]);
export type EstimateStatusValue = z.infer<typeof estimateStatusSchema>;

export const invoiceStatusSchema = z.enum([
  'draft',
  'open',
  'partially_paid',
  'paid',
  'void',
  'canceled',
]);
export type InvoiceStatusValue = z.infer<typeof invoiceStatusSchema>;

export const proposalStatusSchema = z.enum([
  'draft',
  'ready_for_review',
  'approved',
  'executing',
  'rejected',
  'expired',
  'executed',
  'execution_failed',
  'undone',
]);
export type ProposalStatusValue = z.infer<typeof proposalStatusSchema>;

/**
 * Registry of canonical status schemas, keyed by entity. Consumed by
 * `status.test.ts` to assert schema ↔ legacy-enum ↔ DB-CHECK parity.
 */
export const STATUS_SCHEMAS = {
  job: jobStatusSchema,
  appointment: appointmentStatusSchema,
  estimate: estimateStatusSchema,
  invoice: invoiceStatusSchema,
  proposal: proposalStatusSchema,
} as const;
