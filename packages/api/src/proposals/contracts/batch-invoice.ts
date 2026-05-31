import { z } from 'zod';

/**
 * batch_invoice proposal payload (P21-003).
 *
 * The morning "you have N jobs ready to invoice" nudge. Capture-class: on
 * approval the execution handler fans out one `draft_invoice` proposal per
 * job (each of those is separately reviewed before sending) — no money moves
 * and nothing is sent here.
 *
 * The per-job `lineItems` are resolved at sweep time from the accepted
 * estimate and carried verbatim (billing-engine LineItems, `unitPriceCents`)
 * so the fan-out doesn't re-query. `passthrough()` keeps those extra fields.
 */
const batchJobSchema = z
  .object({
    jobId: z.string().uuid(),
    customerId: z.string().uuid(),
    estimateId: z.string().uuid().optional(),
    amountCents: z.number().int().min(0),
    discountCents: z.number().int().min(0).optional(),
    taxRateBps: z.number().int().min(0).max(10000).optional(),
    lineItems: z.array(z.record(z.unknown())).min(1),
  })
  .passthrough();

export const batchInvoicePayloadSchema = z.object({
  /** Calendar date (YYYY-MM-DD) the batch was generated for. */
  batchDate: z.string().min(1),
  totalCents: z.number().int().min(0),
  jobs: z.array(batchJobSchema).min(1),
});

export type BatchInvoicePayload = z.infer<typeof batchInvoicePayloadSchema>;
