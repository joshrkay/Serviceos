import { z } from 'zod';

/**
 * issue_invoice proposal payload (P22-002).
 *
 * Issues an existing DRAFT invoice: transitions draft → open, stamps
 * `issuedAt`, and computes `dueDate` from the tenant's default payment
 * terms in the tenant timezone. "Issue" makes the invoice official and
 * payable; it does NOT deliver it to the customer — that is the
 * separate `send_invoice` comms action.
 *
 * `invoiceId` accepts either a UUID (assistant platform) or a
 * human-readable invoice number like "INV-0042" / bare "0042" (voice
 * commands) — the execution handler resolves either form. This matches
 * the established `issueInvoicePayloadSchema` in proposals/contracts.ts.
 *
 * `paymentTermDays`, when present, overrides the tenant default
 * (settings.defaultPaymentTermDays, falling back to 30).
 */
export const issueInvoicePayloadSchema = z.object({
  invoiceId: z.string().min(1),
  paymentTermDays: z.number().int().min(1).max(365).optional(),
});

export type IssueInvoicePayload = z.infer<typeof issueInvoicePayloadSchema>;
