import { z } from 'zod';
import { PreferredChannel } from '../enums.js';

/**
 * Canonical Customer entity contract — single source of truth for the customer
 * shape the API serializes, reconciled to `packages/api/src/customers/customer.ts`
 * (`interface Customer`) and the customers table.
 *
 * Over-the-wire dates are ISO strings (the entity uses `Date` server-side).
 * `preferredChannel` reuses the shared PreferredChannel enum. This is the full
 * record; the smaller embedded shape used by GET /api/jobs/:id lives as
 * jobCustomerSummarySchema in ./job.ts.
 *
 * Web migration (the per-page local `ApiCustomer` redefs) is a follow-up that
 * needs the running app to verify rendering, as with the Job entity.
 */
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
  preferredChannel: z.nativeEnum(PreferredChannel),
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
