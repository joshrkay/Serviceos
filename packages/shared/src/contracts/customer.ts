import { z } from 'zod';

/**
 * Canonical Customer entity contract — single source of truth for the customer
 * shape the API serializes, reconciled to `packages/api/src/customers/customer.ts`
 * (`interface Customer`) and the customers table.
 *
 * Over-the-wire dates are ISO strings (the entity uses `Date` server-side).
 * The smaller embedded shape used by GET /api/jobs/:id lives as
 * jobCustomerSummarySchema in ./job.ts.
 *
 * Web migration (the per-page local `ApiCustomer` redefs) is a follow-up that
 * needs the running app to verify rendering, as with the Job entity.
 */

/**
 * Preferred contact channel — string-literal union from the DB-true values
 * (`customers.preferred_channel` CHECK, DEFAULT 'none'), kept in lockstep with
 * the PreferredChannel enum and the DB by customer.test.ts. Defined here rather
 * than via z.nativeEnum so it can't silently drift from the persisted set.
 */
export const preferredChannelSchema = z.enum(['phone', 'email', 'sms', 'none']);
export type PreferredChannelValue = z.infer<typeof preferredChannelSchema>;
export const customerSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  firstName: z.string(),
  lastName: z.string(),
  displayName: z.string(),
  companyName: z.string().optional(),
  primaryPhone: z.string().optional(),
  secondaryPhone: z.string().optional(),
  email: z.string().optional(),
  preferredChannel: preferredChannelSchema,
  smsConsent: z.boolean(),
  communicationNotes: z.string().optional(),
  isArchived: z.boolean(),
  archivedAt: z.string().optional(),
  originatingLeadId: z.string().optional(),
  preferredLanguage: z.string().optional(),
  dateOfBirth: z.string().optional(),
  accountType: z.enum(['residential', 'b2b']).optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Customer = z.infer<typeof customerSchema>;

/**
 * Minimal customer summary embedded in enriched list/detail responses for other
 * entities (e.g. the optional `customer` on an invoice/job response). A subset
 * of the full Customer record — just what list/detail views render.
 */
export const customerSummarySchema = z.object({
  id: z.string(),
  displayName: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  primaryPhone: z.string().optional(),
  email: z.string().optional(),
});
export type CustomerSummary = z.infer<typeof customerSummarySchema>;
