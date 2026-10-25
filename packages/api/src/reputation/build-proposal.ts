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
 *   7. assemble payload, return it with the public-reply run's id.
 *
 * All `approved` flags default to `false`. The operator approves each
 * component independently in the review UI. The execution handler
 * dispatches per-flag — see `proposals/execution/review-response-handler.ts`.
 *
 * Cap enforcement at DRAFT time (not approval time) keeps the owner
 * UI honest: if the cap is exhausted, the credit component is
 * `null` and the operator never sees a vacuous "approve a $0 credit"
 * affordance. A delayed approval after a separate credit was issued in
 * the meantime is caught at EXECUTE time: the handler re-reads the
 * rolling sum under a per-customer lock and refuses (never clamps) a
 * credit that would now exceed the cap (#1080; both halves share
 * `exceedsCreditCap`).
 */

import { LLMGateway } from '../ai/gateway/gateway';
import { BrandVoiceLoader } from './brand-voice';
import { ClassificationResult, ClassifyReviewDeps, classifyReview } from './classifier';
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
    deps: ClassifyReviewDeps,
  ) => Promise<ClassificationResult>;
  matcher?: (
    review: Review,
    deps: { customerLoader: CustomerLoader },
  ) => Promise<MatchedCustomer | null>;
  draftPublic?: typeof draftPublicResponse;
  draftPrivate?: typeof draftPrivateFollowUp;
}

export interface BuildReviewResponseProposalOptions {
  /**
   * OBS-2 — the join keys every model call in this pipeline passes to the
   * gateway, so its ai_runs rows (classification, public reply, private
   * follow-up) share one correlation_id. Per review, so it is not part of the
   * deps bundle (the polling worker reuses that across every review). Each
   * creator picks its key: the call or conversation for a spoken request
   * (`draftingRunMetadata`), the review for the polling worker.
   */
  runMetadata?: Record<string, unknown>;
}

export interface ReviewResponseDraft {
  payload: ReviewResponseProposalPayload;
  /**
   * OBS-2 — the run the proposal links (`proposals.ai_run_id`): the one that
   * wrote the public reply, the component every review response has and the
   * text posted to Google. The classification and private follow-up runs are
   * found by the shared correlation_id. Absent when the gateway persisted no
   * run (the FK needs a real row).
   */
  aiRunId?: string;
}

export async function buildReviewResponseProposal(
  review: Review,
  deps: BuildReviewResponseProposalDeps,
  options: BuildReviewResponseProposalOptions = {},
): Promise<ReviewResponseDraft> {
  const classifier = deps.classifier ?? classifyReview;
  const matcher = deps.matcher ?? matchReviewerToCustomer;
  const draftPublic = deps.draftPublic ?? draftPublicResponse;
  const draftPrivate = deps.draftPrivate ?? draftPrivateFollowUp;
  const llm = {
    llmGateway: deps.llmGateway,
    ...(options.runMetadata ? { runMetadata: options.runMetadata } : {}),
  };

  // 1. Classify.
  const classification = await classifier(review, llm);

  // 2. Match reviewer → customer. Conservative — returns null when
  // uncertain. The downstream components fork on this null/non-null.
  const matched = await matcher(review, { customerLoader: deps.customerLoader });

  // 3. Brand voice.
  const brandVoice = await deps.brandVoiceLoader.load(review.tenantId);

  // 4. Public response — ALWAYS drafted (every review gets a public
  // reply option, matched or not). Input + output PII redaction
  // lives inside the composer.
  const publicReply = await draftPublic(
    {
      review,
      classification: classification.classification,
      brandVoice,
    },
    llm,
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
      llm,
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
    payload: {
      reviewId: review.id,
      classification: classification.classification,
      publicResponse: {
        text: publicReply.text,
        approved: false,
      },
      privateFollowUp,
      serviceCredit,
    },
    ...(publicReply.aiRunId ? { aiRunId: publicReply.aiRunId } : {}),
  };
}
