import { z } from 'zod';
import { JobPriority } from '../enums.js';
import { jobStatusSchema } from './status.js';

/**
 * Canonical Job entity contract — the single source of truth for the job shape
 * the API serializes, reconciled to `packages/api/src/jobs/job.ts` (`interface
 * Job`) and the jobs table in schema.ts. `status` reuses jobStatusSchema, so the
 * DB-parity guard in status.test.ts covers it transitively.
 *
 * Over-the-wire dates are ISO strings (the entity uses `Date` server-side, which
 * JSON-serializes to a string), so `createdAt`/`updatedAt` are typed `string`
 * here, matching proposalResponseSchema.
 *
 * Web components (e.g. JobDetail's `ApiJobDetail`, JobsList's `ApiJob`) should
 * migrate onto these types. That migration is deliberately a separate PR: those
 * local interfaces over-declare fields the endpoints don't actually send
 * (technician, lineItems, scheduledStart, serviceType), so the swap needs the
 * running app to verify rendering rather than a type-only check.
 */

/** Money-state rollup marker. TODO(follow-up): reconcile to the JobMoneyState union + a DB-parity test. */
export const jobMoneyStateSchema = z.string();

export const jobSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  customerId: z.string().uuid(),
  locationId: z.string().uuid(),
  jobNumber: z.string(),
  summary: z.string(),
  problemDescription: z.string().optional(),
  status: jobStatusSchema,
  priority: z.nativeEnum(JobPriority),
  assignedTechnicianId: z.string().optional(),
  originatingLeadId: z.string().optional(),
  depositRequiredCents: z.number().int().optional(),
  depositPaidCents: z.number().int().optional(),
  depositStatus: z.enum(['not_required', 'pending', 'paid']).optional(),
  depositStripePaymentLinkId: z.string().optional(),
  depositStripePaymentLinkUrl: z.string().optional(),
  depositCreditedToInvoiceId: z.string().optional(),
  moneyState: jobMoneyStateSchema.optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Job = z.infer<typeof jobSchema>;

/** A service location as embedded in the job-detail response (subset of the full location row). */
export const jobLocationSummarySchema = z.object({
  id: z.string().optional(),
  street1: z.string().optional(),
  street2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  isPrimary: z.boolean().optional(),
  label: z.string().optional(),
});
export type JobLocationSummary = z.infer<typeof jobLocationSummarySchema>;

/** The customer summary embedded in the job-detail response (see GET /api/jobs/:id). */
export const jobCustomerSummarySchema = z.object({
  id: z.string(),
  displayName: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  primaryPhone: z.string().optional(),
  email: z.string().optional(),
  communicationNotes: z.string().optional(),
  locations: z.array(jobLocationSummarySchema).optional(),
});
export type JobCustomerSummary = z.infer<typeof jobCustomerSummarySchema>;

/**
 * Shape returned by `GET /api/jobs/:id`: the Job entity enriched with an
 * embedded customer summary and the resolved service location.
 */
export const jobDetailResponseSchema = jobSchema.extend({
  customer: jobCustomerSummarySchema.optional(),
  location: jobLocationSummarySchema.optional(),
});
export type JobDetailResponse = z.infer<typeof jobDetailResponseSchema>;
