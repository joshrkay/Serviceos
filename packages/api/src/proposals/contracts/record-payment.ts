import { z } from 'zod';

/**
 * record_payment proposal payload.
 *
 * Logs a payment received against an invoice. Money-moving — always
 * drafted, never auto-approved, always requires a screen-tap
 * approval per CLAUDE.md "Never auto-execute" and Decision 3 "money
 * class never auto-approves".
 *
 * Amount is in integer cents (never floating point — see CLAUDE.md
 * core patterns).
 */
export const recordPaymentPayloadSchema = z
  .object({
    invoiceId: z.string().uuid().optional(),
    invoiceReference: z.string().optional(),
    amountCents: z.number().int().positive(),
    paymentMethod: z.enum(['cash', 'check', 'card', 'other']),
    paymentReference: z.string().optional(),
    receivedAt: z.string().optional(),
    notes: z.string().optional(),
  })
  .refine((v) => Boolean(v.invoiceId || v.invoiceReference), {
    message: 'Either invoiceId or invoiceReference is required',
  });

export type RecordPaymentPayload = z.infer<typeof recordPaymentPayloadSchema>;
