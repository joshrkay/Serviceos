import { z } from 'zod';

/**
 * send_invoice proposal payload.
 *
 * Delivers an existing invoice to a customer via email or SMS. This
 * is a customer-comms action — per Decision 3 and CLAUDE.md ("Never
 * auto-execute"), it is always routed to 'draft' and requires an
 * explicit screen-tap approval; voice "yes" is NOT sufficient.
 *
 * `invoiceReference` (e.g., "INV-0042" or a customer name) lives
 * alongside `invoiceId` because the classifier does not touch the DB
 * and often only has a free-text reference at proposal-creation time.
 */
export const sendInvoicePayloadSchema = z
  .object({
    invoiceId: z.string().uuid().optional(),
    invoiceReference: z.string().optional(),
    channel: z.enum(['email', 'sms']),
    recipient: z.string().optional(),
    customMessage: z.string().optional(),
  })
  .refine((v) => Boolean(v.invoiceId || v.invoiceReference), {
    message: 'Either invoiceId or invoiceReference is required',
  });

export type SendInvoicePayload = z.infer<typeof sendInvoicePayloadSchema>;
