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
  accountType: z.enum(['residential', 'b2b', 'property_manager']).optional(),
  parentAccountId: z.string().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Customer = z.infer<typeof customerSchema>;

/**
 * U1 (CRM Jobber parity) — a contact attached to a customer. A B2B /
 * property-manager account separates the decision-maker (`primary`), the
 * bill-to (`billing`), and the on-site contact (`site`) onto distinct rows.
 * Kept in lockstep with `customer_contacts.role` (migration 186) and the
 * server-side `CustomerContactRole` in
 * `packages/api/src/customers/contact.ts`. Defined as a string-literal enum
 * (not z.nativeEnum) so it can't silently drift from the persisted set.
 */
export const customerContactRoleSchema = z.enum(['primary', 'billing', 'site', 'other']);
export type CustomerContactRole = z.infer<typeof customerContactRoleSchema>;

export const customerContactSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  customerId: z.string().uuid(),
  name: z.string(),
  role: customerContactRoleSchema,
  phone: z.string().optional(),
  email: z.string().optional(),
  isPrimary: z.boolean(),
  notes: z.string().optional(),
  isArchived: z.boolean(),
  archivedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CustomerContact = z.infer<typeof customerContactSchema>;

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

/**
 * Per-location summary embedded in a customer list row. `serviceTypes` is left
 * as free strings here (the web narrows to its local ServiceType union); the
 * authoritative service-type set lives client-side for now.
 */
export const customerLocationSummarySchema = z.object({
  id: z.string(),
  street1: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  serviceTypes: z.array(z.string()).optional(),
});
export type CustomerLocationSummary = z.infer<typeof customerLocationSummarySchema>;

/**
 * Shape consumed by the customers list UI: the Customer entity plus optional
 * list-view enrichments the row renders (open-job count, tags, last-service
 * label, and per-location service-type chips). All enrichments are optional —
 * a plain customer entity (without joins) still validates.
 */
export const customerListItemSchema = customerSchema.extend({
  openJobs: z.number().int().optional(),
  tags: z.array(z.string()).optional(),
  lastService: z.string().optional(),
  locations: z.array(customerLocationSummarySchema).optional(),
});
export type CustomerListItem = z.infer<typeof customerListItemSchema>;
