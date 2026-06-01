import { z } from 'zod';
import { invoiceStatusSchema } from './status.js';
import { lineItemSchema, documentTotalsSchema } from './money.js';

/**
 * Canonical Invoice entity contract — single source of truth for the invoice
 * shape the API serializes, reconciled to `packages/api/src/invoices/invoice.ts`
 * (`interface Invoice`). `status` reuses invoiceStatusSchema (DB-parity guarded
 * by status.test.ts); lineItems/totals reuse the shared billing primitives in
 * ./money.ts. amountPaid/amountDue are integer cents; dates are ISO strings.
 */
export const invoiceSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  jobId: z.string().uuid(),
  estimateId: z.string().uuid().optional(),
  invoiceNumber: z.string(),
  status: invoiceStatusSchema,
  lineItems: z.array(lineItemSchema),
  totals: documentTotalsSchema,
  amountPaidCents: z.number().int(),
  amountDueCents: z.number().int(),
  issuedAt: z.string().optional(),
  dueDate: z.string().optional(),
  customerMessage: z.string().optional(),
  viewToken: z.string().optional(),
  viewTokenExpiresAt: z.string().optional(),
  sentAt: z.string().optional(),
  lastDispatchId: z.string().optional(),
  firstViewedAt: z.string().optional(),
  viewCount: z.number().int().optional(),
  stripePaymentLinkId: z.string().optional(),
  stripePaymentLinkUrl: z.string().optional(),
  originatingLeadId: z.string().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Invoice = z.infer<typeof invoiceSchema>;
