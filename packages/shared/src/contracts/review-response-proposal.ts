/**
 * P7-026 — Zod contracts for the `review_response` proposal payload.
 *
 * Lives in `packages/shared/` because the same shape is consumed by
 * both the API (validation at proposal-create / proposal-execute time)
 * and the eventual web UI (rendering of public/private/credit
 * sub-payloads as three independently-approvable cards).
 *
 * Discriminated structure (sub-payloads, not separate proposals):
 *   - publicResponse  — public Google reply draft (optional only when
 *     the review is classified `wrong_business`, in which case the
 *     proposal builder short-circuits and never creates a proposal at
 *     all; once a proposal exists, the public draft is always present)
 *   - privateMessage  — private SMS/email apology (present only when
 *     the matcher returned 'high' confidence)
 *   - serviceCredit   — owner-approved credit suggestion (present only
 *     when a high-confidence match plus a non-zero credit tier after
 *     12-month cap clamping)
 *
 * Independent approval is surfaced via `componentDecisionSchema` —
 * the owner can approve, edit, or reject each sub-payload separately;
 * the execution handler walks the decisions and only acts on the
 * approved components.
 *
 * Money is integer cents per CLAUDE.md ("All money: integer cents,
 * never floating point").
 */

import { z } from 'zod';

export const REVIEW_CLASSIFICATION = [
  'praise',
  'specific_complaint',
  'vague_complaint',
  'wrong_business',
] as const;

export const MATCH_CONFIDENCE = ['high', 'low', 'none'] as const;

/**
 * Owner approval status per sub-payload. The shape mirrors the
 * top-level ProposalStatus enum so a future refactor can collapse the
 * two. 'approved' here means "owner approved THIS sub-payload" — not
 * the entire proposal.
 */
export const componentDecisionSchema = z.enum([
  'pending',
  'approved',
  'edited',
  'rejected',
]);
export type ComponentDecision = z.infer<typeof componentDecisionSchema>;

export const publicResponseSubPayloadSchema = z.object({
  draft: z.string().min(1).max(2000),
  /** Owner-edited version. Set when `decision === 'edited'`. */
  editedText: z.string().min(1).max(2000).optional(),
  decision: componentDecisionSchema.default('pending'),
});
export type PublicResponseSubPayload = z.infer<typeof publicResponseSubPayloadSchema>;

export const privateMessageSubPayloadSchema = z.object({
  channel: z.enum(['sms', 'email']),
  draft: z.string().min(1).max(2000),
  editedText: z.string().min(1).max(2000).optional(),
  decision: componentDecisionSchema.default('pending'),
});
export type PrivateMessageSubPayload = z.infer<typeof privateMessageSubPayloadSchema>;

/**
 * Service-credit sub-payload. amountCents is the bounded amount the
 * builder produced after the 12-month cap clamp; if the owner edits
 * the credit upward, the execution handler MUST re-run the cap query
 * and refuse to issue an amount above the remaining cap (the cap is
 * a hard rule per the dispatch addendum's "Credit cap bypass" risk
 * note).
 */
export const serviceCreditSubPayloadSchema = z.object({
  amountCents: z.number().int().nonnegative().max(10000),
  /** What the operator sees: "$X of $100 left this year". */
  remainingCapCents: z.number().int().nonnegative(),
  /** True iff the cap query clamped the suggested tier. */
  capApplied: z.boolean(),
  /** Owner edits roll into editedAmountCents (still bounded by cap). */
  editedAmountCents: z.number().int().nonnegative().max(10000).optional(),
  decision: componentDecisionSchema.default('pending'),
});
export type ServiceCreditSubPayload = z.infer<typeof serviceCreditSubPayloadSchema>;

/**
 * The top-level payload for a `review_response` proposal. The
 * `payload` field on the underlying `Proposal` record carries an
 * object that parses against this schema.
 */
export const reviewResponseProposalPayloadSchema = z.object({
  reviewId: z.string().uuid(),
  classification: z.enum(REVIEW_CLASSIFICATION),
  matchConfidence: z.enum(MATCH_CONFIDENCE),
  matchedCustomerId: z.string().uuid().optional(),
  publicResponse: publicResponseSubPayloadSchema.optional(),
  privateMessage: privateMessageSubPayloadSchema.optional(),
  serviceCredit: serviceCreditSubPayloadSchema.optional(),
});
export type ReviewResponseProposalPayload = z.infer<typeof reviewResponseProposalPayloadSchema>;

/** Discriminant string for type-narrowing in handlers + UI. */
export const REVIEW_RESPONSE_PROPOSAL_TYPE = 'review_response' as const;
export type ReviewResponseProposalType = typeof REVIEW_RESPONSE_PROPOSAL_TYPE;

/** Hard cap surfaced for UI display. Keep in sync with credit-tier.ts. */
export const REVIEW_RESPONSE_CREDIT_CAP_CENTS = 10000;
