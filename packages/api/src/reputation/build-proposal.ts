/**
 * P7-026 — Build a `review_response` proposal from a Google review.
 *
 * Wires the classifier output + customer match + credit suggestion
 * into a single proposal whose payload carries three independently-
 * approvable sub-payloads:
 *   - public-response  (always present unless classification is 'wrong_business')
 *   - private-message  (present only when matchConfidence === 'high')
 *   - service-credit   (present only when match is high and credit > 0)
 *
 * Idempotency: the caller must check `googleReview.proposalId` and
 * skip building if a proposal was already created for this review
 * (per the dispatch addendum's "Idempotency on review IDs" risk note).
 *
 * The proposal always lands in 'draft' status — review_response is a
 * customer-comms action class, which per `decideInitialStatus` never
 * auto-approves regardless of trust tier. The owner must approve.
 */

import { LLMGateway } from '../ai/gateway/gateway';
import { createProposal, type CreateProposalInput, type Proposal, type ProposalType } from '../proposals/proposal';
import { boundCreditByCap } from './credit-tier';
import { suggestCreditTier } from './credit-tier';
import { buildPrivateDraft, buildPublicDraft } from './draft-builders';
import type { TenantBrandContext, MatchedCustomerContext } from './draft-builders';
import type { ServiceCreditRepository } from './service-credit-repository';
import type {
  GoogleReview,
  MatchConfidence,
} from './types';

export interface BuildReviewResponseProposalInput {
  review: GoogleReview;
  brand: TenantBrandContext;
  /**
   * Populated when the customer matcher returned 'high' or 'low'.
   * 'low' carries the customer id only for surface-flagging — the
   * proposal builder omits the private + credit sub-payloads in that
   * case (per "low → unverified, omit private" rule).
   */
  matched?: { confidence: MatchConfidence; customer: MatchedCustomerContext };
  gateway: LLMGateway;
  creditRepo: ServiceCreditRepository;
  createdBy: string;
  now: Date;
}

/**
 * The discriminant payload type used inside the proposal.payload
 * field. The Zod schema lives in
 * `packages/shared/src/contracts/review-response-proposal.ts` and is
 * imported by both the API (for validation) and the web app (for
 * rendering); this interface mirrors the shape for code completion.
 */
export interface ReviewResponsePayload {
  reviewId: string;
  classification: GoogleReview['classification'];
  matchConfidence: MatchConfidence;
  matchedCustomerId?: string;
  publicResponse?: { draft: string };
  privateMessage?: { channel: 'sms' | 'email'; draft: string };
  serviceCredit?: {
    amountCents: number;
    remainingCapCents: number;
    capApplied: boolean;
  };
}

export interface BuildResult {
  proposal: Proposal | null;
  reason?: string;
}

export async function buildReviewResponseProposal(
  input: BuildReviewResponseProposalInput,
): Promise<BuildResult> {
  const cls = input.review.classification;
  if (!cls) {
    return { proposal: null, reason: 'review is not yet classified' };
  }

  // Wrong-business: silent skip per spec. The build-proposal caller
  // is responsible for emitting the audit log for this skip — we just
  // return null so no proposal is drafted.
  if (cls === 'wrong_business') {
    return { proposal: null, reason: 'wrong_business — no proposal drafted' };
  }

  // Praise reviews: draft a public thank-you ONLY. No private message,
  // no credit. The owner can edit/reject; the proposal still routes
  // through the standard human-review queue.
  // Negative reviews: draft public + (if high-confidence match) private +
  // (if appropriate) credit.

  const isHighMatch =
    input.matched?.confidence === 'high' && cls !== 'praise';

  // Public draft. Short-circuits on wrong_business, which we've
  // already handled above; safe to call here.
  const publicDraft = await buildPublicDraft({
    tenantId: input.review.tenantId,
    review: {
      rating: input.review.rating,
      commentText: input.review.commentText,
      reviewerName: input.review.reviewerName,
      classification: cls,
    },
    brand: input.brand,
    matched: isHighMatch ? input.matched!.customer : undefined,
    gateway: input.gateway,
  });

  // Private draft + credit only when match is high.
  let privateDraft: { channel: 'sms' | 'email'; draft: string } | undefined;
  let credit:
    | { amountCents: number; remainingCapCents: number; capApplied: boolean }
    | undefined;

  if (isHighMatch && input.matched) {
    const matched = input.matched.customer;
    const priv = await buildPrivateDraft({
      tenantId: input.review.tenantId,
      review: input.review,
      brand: input.brand,
      matched,
      gateway: input.gateway,
    });
    privateDraft = { channel: priv.channel, draft: priv.text };

    const proposedCents = suggestCreditTier({
      classification: cls,
      matchConfidence: 'high',
      rating: input.review.rating,
    });
    if (proposedCents > 0) {
      const bounded = await boundCreditByCap({
        tenantId: input.review.tenantId,
        customerId: matched.customerId,
        proposedAmountCents: proposedCents,
        now: input.now,
        repo: input.creditRepo,
      });
      if (bounded.amountCents > 0) {
        credit = {
          amountCents: bounded.amountCents,
          remainingCapCents: bounded.remainingCapCents,
          capApplied: bounded.capApplied,
        };
      }
    }
  }

  const payload: ReviewResponsePayload = {
    reviewId: input.review.id,
    classification: cls,
    matchConfidence: input.matched?.confidence ?? 'none',
    ...(input.matched?.customer.customerId && {
      matchedCustomerId: input.matched.customer.customerId,
    }),
    ...(publicDraft && { publicResponse: { draft: publicDraft.text } }),
    ...(privateDraft && { privateMessage: privateDraft }),
    ...(credit && { serviceCredit: credit }),
  };

  const summary = summariseProposal(input.review, cls, privateDraft, credit);
  // P7-026 — 'review_response' is cast to ProposalType. See
  // ReviewResponseExecutionHandler for the rationale (the dispatch
  // addendum forbids touching the exhaustive Record<ProposalType, X>
  // files in packages/api/src/proposals/contracts.ts and
  // packages/api/src/proposals/prioritization.ts, which would otherwise
  // need additive entries to satisfy the type system).
  const createInput: CreateProposalInput = {
    tenantId: input.review.tenantId,
    proposalType: 'review_response' as ProposalType,
    payload: payload as unknown as Record<string, unknown>,
    summary,
    explanation: `Google review (${input.review.rating}/5) by ${input.review.reviewerName}`,
    targetEntityType: 'google_review',
    targetEntityId: input.review.id,
    createdBy: input.createdBy,
  };
  return { proposal: createProposal(createInput), reason: undefined };
}

function summariseProposal(
  review: GoogleReview,
  classification: NonNullable<GoogleReview['classification']>,
  privateDraft: BuildResult extends never ? never : { draft: string } | undefined,
  credit:
    | { amountCents: number; remainingCapCents: number; capApplied: boolean }
    | undefined,
): string {
  const parts: string[] = [];
  parts.push(`Review response (${classification})`);
  parts.push(`${review.rating}-star review by ${review.reviewerName}`);
  if (privateDraft) parts.push('private apology drafted');
  if (credit && credit.amountCents > 0) {
    parts.push(`$${(credit.amountCents / 100).toFixed(2)} credit suggested`);
  }
  return parts.join(' — ');
}
