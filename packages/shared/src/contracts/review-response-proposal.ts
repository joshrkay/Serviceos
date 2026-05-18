/**
 * P7-026 PR c — Zod contract for the 3-component `review_response_proposal`.
 *
 * Each Google review the system surfaces becomes ONE proposal whose
 * payload bundles three independently-approvable sub-actions:
 *
 *   1. publicResponse  — owner-approved public reply posted to GBP.
 *   2. privateFollowUp — owner-approved 1:1 message (email/SMS) to the
 *                        matched customer. `null` when the matcher
 *                        could not confidently link the reviewer to a
 *                        local customer.
 *   3. serviceCredit   — owner-approved $ credit (cents) applied to the
 *                        matched customer's account. `null` when no
 *                        match, when the credit tier is $0 (e.g.
 *                        praise), or when the rolling $100/12-month
 *                        cap is exhausted.
 *
 * Each component carries its own `approved` boolean so the operator
 * can mix-and-match at review time (e.g. approve the public response
 * but skip the credit). The execution handler dispatches per-flag —
 * see `proposals/execution/review-response-handler.ts`.
 *
 * The cap is enforced at DRAFT time (in `reputation/build-proposal.ts`),
 * not at approval time: if applying this credit would push the
 * customer's rolling 12-month credit total over the $100 cap, the
 * `serviceCredit` field is omitted (set to `null`) entirely. This
 * keeps the owner from seeing a credit suggestion they cannot
 * approve — a cleaner UX than greying-out an in-payload component.
 */
import { z } from 'zod';

/**
 * Conservative cap on the public response body. Google Business
 * Profile accepts up to ~4096 characters per reply, but most operator
 * responses are <1000; capping at 2000 keeps the LLM from generating
 * runaway essays while leaving plenty of headroom for tonal nuance.
 */
export const PUBLIC_RESPONSE_MAX_CHARS = 2000;

/**
 * Conservative cap on the private follow-up body. SMS is hard-capped
 * at 1600 chars by Twilio; email is unbounded; 2000 keeps both
 * channels safe and rejects LLM runaways.
 */
export const PRIVATE_FOLLOWUP_MAX_CHARS = 2000;

export const REVIEW_CLASSIFICATIONS = ['praise', 'specific_complaint', 'vague_complaint'] as const;
export type ReviewClassificationLabel = (typeof REVIEW_CLASSIFICATIONS)[number];

export const PRIVATE_FOLLOWUP_CHANNELS = ['email', 'sms'] as const;
export type PrivateFollowUpChannel = (typeof PRIVATE_FOLLOWUP_CHANNELS)[number];

export const reviewResponsePublicComponentSchema = z.object({
  text: z.string().min(1).max(PUBLIC_RESPONSE_MAX_CHARS),
  approved: z.boolean(),
});

export const reviewResponsePrivateComponentSchema = z.object({
  customerId: z.string().uuid(),
  channel: z.enum(PRIVATE_FOLLOWUP_CHANNELS),
  body: z.string().min(1).max(PRIVATE_FOLLOWUP_MAX_CHARS),
  approved: z.boolean(),
});

export const reviewResponseCreditComponentSchema = z.object({
  customerId: z.string().uuid(),
  // Integer cents; > 0 (`null` outer field encodes "no credit").
  amountCents: z.number().int().positive(),
  approved: z.boolean(),
});

export const reviewResponseProposalPayloadSchema = z.object({
  reviewId: z.string().uuid(),
  classification: z.enum(REVIEW_CLASSIFICATIONS),
  publicResponse: reviewResponsePublicComponentSchema,
  privateFollowUp: reviewResponsePrivateComponentSchema.nullable(),
  serviceCredit: reviewResponseCreditComponentSchema.nullable(),
});

export type ReviewResponseProposalPayload = z.infer<
  typeof reviewResponseProposalPayloadSchema
>;

export type ReviewResponsePublicComponent = z.infer<
  typeof reviewResponsePublicComponentSchema
>;
export type ReviewResponsePrivateComponent = z.infer<
  typeof reviewResponsePrivateComponentSchema
>;
export type ReviewResponseCreditComponent = z.infer<
  typeof reviewResponseCreditComponentSchema
>;
