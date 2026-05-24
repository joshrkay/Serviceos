import { z } from 'zod';

/**
 * send_estimate proposal payload.
 *
 * Delivers an existing estimate's customer approval link via email or
 * SMS. Like send_invoice this is a customer-comms action — per
 * Decision 3 and CLAUDE.md ("Never auto-execute"), it is always routed
 * to 'draft' and requires an explicit screen-tap approval; a voice
 * "yes" is NOT sufficient.
 *
 * `estimateReference` (e.g., "EST-0042" or a customer name) lives
 * alongside `estimateId` because the classifier does not touch the DB
 * and often only has a free-text reference at proposal-creation time;
 * the review step resolves it to a concrete `estimateId`.
 */
export const sendEstimatePayloadSchema = z
  .object({
    estimateId: z.string().uuid().optional(),
    estimateReference: z.string().optional(),
    channel: z.enum(['email', 'sms']),
    recipient: z.string().optional(),
    customMessage: z.string().optional(),
  })
  .refine((v) => Boolean(v.estimateId || v.estimateReference), {
    message: 'Either estimateId or estimateReference is required',
  });

export type SendEstimatePayload = z.infer<typeof sendEstimatePayloadSchema>;
