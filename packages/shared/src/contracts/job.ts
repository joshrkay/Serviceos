import { z } from 'zod';
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
 */

/** Money-state rollup marker. TODO(follow-up): reconcile to the JobMoneyState union + a DB-parity test. */
export const jobMoneyStateSchema = z.string();

/**
 * Job priority as a string-literal union (kept in lockstep with the JobPriority
 * enum by job.test.ts). A literal union — not z.nativeEnum — so consumers can
 * compare against literals (e.g. `priority === 'urgent'`) without TS friction.
 */
export const jobPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export type JobPriorityValue = z.infer<typeof jobPrioritySchema>;

export const jobSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  customerId: z.string().uuid(),
  locationId: z.string().uuid(),
  jobNumber: z.string(),
  summary: z.string(),
  problemDescription: z.string().optional(),
  status: jobStatusSchema,
  priority: jobPrioritySchema,
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
/** Minimal technician summary embedded in enriched job responses (name + lane color). */
export const jobTechnicianSummarySchema = z.object({
  id: z.string(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  color: z.string().optional(),
});
export type JobTechnicianSummary = z.infer<typeof jobTechnicianSummarySchema>;

/**
 * Shape returned by `GET /api/jobs/:id`: the Job entity enriched with an
 * embedded customer summary and the resolved service location. `technician` and
 * `serviceType` are optional enrichment a caller may join in (the detail view
 * renders them when present and falls back when absent), modeled optional so an
 * unenriched response still validates.
 */
export const jobDetailResponseSchema = jobSchema.extend({
  customer: jobCustomerSummarySchema.optional(),
  location: jobLocationSummarySchema.optional(),
  technician: jobTechnicianSummarySchema.optional(),
  serviceType: z.string().optional(),
});
export type JobDetailResponse = z.infer<typeof jobDetailResponseSchema>;

/**
 * Job as consumed by list UIs. The bare `GET /api/jobs` list returns Job
 * entities; `customer`, `technician`, `scheduledStart`, and `serviceType` are
 * optional enrichment a caller may join in (the list view renders them when
 * present and falls back when absent). Modeled optional so an unenriched
 * response still validates.
 */
export const jobListItemSchema = jobSchema.extend({
  customer: jobCustomerSummarySchema.optional(),
  technician: jobTechnicianSummarySchema.optional(),
  scheduledStart: z.string().optional(),
  serviceType: z.string().optional(),
});
export type JobListItem = z.infer<typeof jobListItemSchema>;
