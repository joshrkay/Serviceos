/**
 * P7-026 PR c — Orchestrator that builds a `review_response_proposal`
 * payload from a Google review.
 *
 * Pipeline:
 *   1. classify(review)         → {classification, confidence, source}
 *   2. match(review)            → MatchedCustomer | null
 *   3. brandVoiceLoader.load()  → tone + signoff (or NEUTRAL)
 *   4. draftPublicResponse()    → public reply text (always)
 *   5. if matched: draftPrivateFollowUp() → private body text
 *   6. if matched:
 *        creditTierForReview()  → requested cents
 *        creditRepo.sum…()      → prior issued in last 12 months
 *        applyCreditCap()       → effective cents (0 → omit component)
 *   7. assemble payload, return.
 *
 * All `approved` flags default to `false`. The operator approves each
 * component independently in the review UI. The execution handler
 * dispatches per-flag — see `proposals/execution/review-response-handler.ts`.
 *
 * Cap enforcement at DRAFT time (not approval time) keeps the owner
 * UI honest: if the cap is exhausted, the credit component is
 * `null` and the operator never sees a vacuous "approve a $0 credit"
 * affordance. Trade-off: a delayed approval after a separate credit
 * was issued in the meantime is still capped at-execute by the
 * issuance path (today the handler does not re-check; documented as
 * a known trade-off in the handler).
 */

import { LLMGateway } from '../ai/gateway/gateway';
import { BrandVoiceLoader } from './brand-voice';
import { ClassificationResult, classifyReview } from './classifier';
import {
  applyCreditCap,
  creditTierForReview,
} from './credit-tier';
import { draftPrivateFollowUp } from './draft-private-followup';
import { draftPublicResponse } from './draft-public-response';
import {
  CustomerLoader,
  MatchedCustomer,
  matchReviewerToCustomer,
} from './match-customer';
import { Review } from './review';
import { ServiceCreditRepository } from './service-credit';

import type {
  PrivateFollowUpChannel,
  ReviewResponseProposalPayload,
} from '@ai-service-os/shared';

/**
 * Default channel for the private follow-up. P4-015 / customer-prefs
 * will replace this with the matched customer's stored
 * `preferredChannel`. Email is the safe default: longer messages
 * tolerated, no SMS opt-in compliance burden, and the customer is
 * known so we definitionally have an email address on file via the
 * matcher's loader.
 */
export const DEFAULT_PRIVATE_FOLLOWUP_CHANNEL: PrivateFollowUpChannel = 'email';

export interface BuildReviewResponseProposalDeps {
  llmGateway: LLMGateway;
  customerLoader: CustomerLoader;
  brandVoiceLoader: BrandVoiceLoader;
  serviceCreditRepo: Pick<
    ServiceCreditRepository,
    'sumIssuedInLast12Months'
  >;
  /**
   * Override hooks for tests. Default to the real implementations
   * imported above. Tests inject mocks to isolate orchestration logic
   * from the underlying LLM / matcher behavior.
   */
  classifier?: (
    review: Review,
    deps: { llmGateway: LLMGateway },
  ) => Promise<ClassificationResult>;
  matcher?: (
    review: Review,
    deps: { customerLoader: CustomerLoader },
  ) => Promise<MatchedCustomer | null>;
  draftPublic?: typeof draftPublicResponse;
  draftPrivate?: typeof draftPrivateFollowUp;
}

export async function buildReviewResponseProposal(
  review: Review,
  deps: BuildReviewResponseProposalDeps,
): Promise<ReviewResponseProposalPayload> {
  const classifier = deps.classifier ?? classifyReview;
  const matcher = deps.matcher ?? matchReviewerToCustomer;
  const draftPublic = deps.draftPublic ?? draftPublicResponse;
  const draftPrivate = deps.draftPrivate ?? draftPrivateFollowUp;

  // 1. Classify.
  const classification = await classifier(review, { llmGateway: deps.llmGateway });

  // 2. Match reviewer → customer. Conservative — returns null when
  // uncertain. The downstream components fork on this null/non-null.
  const matched = await matcher(review, { customerLoader: deps.customerLoader });

  // 3. Brand voice.
  const brandVoice = await deps.brandVoiceLoader.load(review.tenantId);

  // 4. Public response — ALWAYS drafted (every review gets a public
  // reply option, matched or not). Input + output PII redaction
  // lives inside the composer.
  const publicText = await draftPublic(
    {
      review,
      classification: classification.classification,
      brandVoice,
    },
    { llmGateway: deps.llmGateway },
  );

  // 5. Private follow-up — only when we have a confident customer
  // match. No match → no private draft (we'd have no one to send it
  // to).
  let privateFollowUp: ReviewResponseProposalPayload['privateFollowUp'] = null;
  if (matched) {
    const body = await draftPrivate(
      {
        review,
        classification: classification.classification,
        brandVoice,
        matchedCustomer: matched,
        channel: DEFAULT_PRIVATE_FOLLOWUP_CHANNEL,
      },
      { llmGateway: deps.llmGateway },
    );
    privateFollowUp = {
      customerId: matched.customerId,
      channel: DEFAULT_PRIVATE_FOLLOWUP_CHANNEL,
      body,
      approved: false,
    };
  }

  // 6. Service credit — only when matched AND the cap allows it.
  let serviceCredit: ReviewResponseProposalPayload['serviceCredit'] = null;
  if (matched) {
    const requestedTier = creditTierForReview(
      classification.classification,
      review.rating,
    );
    if (requestedTier > 0) {
      const priorIssued = await deps.serviceCreditRepo.sumIssuedInLast12Months(
        review.tenantId,
        matched.customerId,
      );
      const cappedAmount = applyCreditCap(requestedTier, priorIssued);
      if (cappedAmount > 0) {
        serviceCredit = {
          customerId: matched.customerId,
          amountCents: cappedAmount,
          approved: false,
        };
      }
    }
  }

  return {
    reviewId: review.id,
    classification: classification.classification,
    publicResponse: {
      text: publicText,
      approved: false,
    },
    privateFollowUp,
    serviceCredit,
  };
}
