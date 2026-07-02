/**
 * U3 (agent wave) — respond_to_review voice on-ramp.
 *
 * "Respond to that 1-star review" → resolve WHICH review deterministically,
 * then draft the SAME `review_response_proposal` the google-reviews polling
 * worker auto-drafts, via the same `buildReviewResponseProposal` orchestrator
 * and the same deps — so a voice-initiated draft is indistinguishable from a
 * poll-initiated one (comms-class: never auto-approves; the owner approves
 * each component in the review UI).
 *
 * Resolution ladder (never a silent guess):
 *   - a star count stated in the reference ("the 1-star from yesterday")
 *     filters to ratings ≤ that count; otherwise default rating ≤ 3;
 *     both within the last 14 days (ReviewRepository.findRecent).
 *   - 0 matches   → voice_clarification ("no recent low review found").
 *   - 2+ matches  → voice_clarification with a candidate picker
 *                   (reviewer + rating + date).
 *   - exactly 1   → dedup against a PENDING (draft / ready_for_review)
 *                   review_response_proposal for the same reviewId — the
 *                   polling worker usually got there first; point the owner
 *                   at the existing inbox card instead of double-drafting.
 *   - fresh draft → buildReviewResponseProposal (LLM via gateway inside),
 *                   idempotencyKey `review_response:{reviewId}`; an LLM /
 *                   drafting failure degrades to a clarification, never a
 *                   dropped utterance.
 */
import {
  createProposal,
  Proposal,
  ProposalRepository,
} from '../../proposals/proposal';
import {
  BuildReviewResponseProposalDeps,
  buildReviewResponseProposal,
} from '../../reputation/build-proposal';
import { Review, ReviewRepository } from '../../reputation/review';
import { ExtractedEntities } from '../orchestration/intent-classifier';
import { TaskContext, TaskHandler, TaskResult } from './task-handlers';

/** How far back "that recent review" reaches. */
export const REVIEW_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
/** Default ceiling when no star count was stated: "low" = 3★ and under. */
export const DEFAULT_MAX_RATING = 3;
/** Candidate cap for the disambiguation picker. */
const CANDIDATE_LIMIT = 5;

const WORD_TO_STARS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

/**
 * Deterministically parse a stated star count out of the spoken reference:
 * "the 1-star from yesterday", "that one star review", "2 stars". Returns
 * undefined when no star count is stated.
 */
export function parseStatedRating(reference: string | undefined): number | undefined {
  if (!reference) return undefined;
  const digit = reference.match(/\b([1-5])\s*-?\s*star/i);
  if (digit) return Number(digit[1]);
  const word = reference.match(/\b(one|two|three|four|five)\s*-?\s*star/i);
  if (word) return WORD_TO_STARS[word[1].toLowerCase()];
  return undefined;
}

function reviewLabel(review: Review): string {
  return review.reviewerDisplayName ?? 'Anonymous reviewer';
}

function reviewHint(review: Review): string {
  return `${review.rating}★ · ${review.createTime.toISOString().slice(0, 10)}`;
}

function summarize(review: Review): string {
  const snippet = (review.commentText ?? '').trim().slice(0, 60);
  return snippet
    ? `Respond to ${review.rating}★ review from ${reviewLabel(review)}: "${snippet}${snippet.length === 60 ? '…' : ''}"`
    : `Respond to ${review.rating}★ review from ${reviewLabel(review)}`;
}

export class RespondToReviewTaskHandler implements TaskHandler {
  readonly taskType = 'review_response_proposal' as const;

  constructor(
    private readonly proposalRepo: ProposalRepository,
    private readonly reviewRepo?: Pick<ReviewRepository, 'findRecent'>,
    private readonly draftDeps?: BuildReviewResponseProposalDeps,
    /** Injectable clock for deterministic lookback-window tests. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = (context.existingEntities ?? {}) as ExtractedEntities;
    const reference =
      typeof ee.reviewReference === 'string' ? ee.reviewReference.trim() : '';

    if (!this.reviewRepo) {
      return this.clarify(context, 'Review lookup is not available right now.');
    }

    const statedRating = parseStatedRating(reference);
    const since = new Date(this.now().getTime() - REVIEW_LOOKBACK_MS);
    const matches = await this.reviewRepo.findRecent(context.tenantId, {
      maxRating: statedRating ?? DEFAULT_MAX_RATING,
      since,
      limit: CANDIDATE_LIMIT,
    });

    if (matches.length === 0) {
      return this.clarify(
        context,
        statedRating !== undefined
          ? `No ${statedRating}-star review found in the last 14 days.`
          : 'No recent low review found to respond to.',
      );
    }

    if (matches.length > 1) {
      // 2+ plausible reviews — one-tap picker, never a silent guess.
      return this.clarifyAmbiguous(context, reference || 'recent review', matches);
    }

    const review = matches[0];

    // Dedup: the google-reviews worker auto-drafts a response for every newly
    // polled low review. If a pending draft already exists for this review,
    // point the owner at the inbox card instead of minting a duplicate.
    const pending = await this.findPendingResponse(context.tenantId, review.id);
    if (pending) {
      return this.clarify(
        context,
        `A draft response to ${reviewLabel(review)}'s ${review.rating}-star review is already in your inbox — open it there to approve or edit.`,
      );
    }

    if (!this.draftDeps) {
      return this.clarify(context, 'Review response drafting is not available right now.');
    }

    let payload;
    try {
      payload = await buildReviewResponseProposal(review, this.draftDeps);
    } catch {
      // LLM / drafting failure — degrade to a clarification so the utterance
      // is never silently dropped; the operator can retry or use the screen.
      return this.clarify(
        context,
        `Found ${reviewLabel(review)}'s ${review.rating}-star review but could not draft a response — try again, or respond from the Reviews screen.`,
      );
    }

    const proposal = createProposal({
      tenantId: context.tenantId,
      proposalType: 'review_response_proposal',
      payload: payload as unknown as Record<string, unknown>,
      summary: summarize(review),
      sourceContext: context.conversationId
        ? { conversationId: context.conversationId }
        : undefined,
      createdBy: context.userId,
      targetEntityType: 'review',
      targetEntityId: review.id,
      // One voice-initiated draft per review, ever — a redelivered recording
      // or a repeated command dedups on this key at the DB layer.
      idempotencyKey: `review_response:${review.id}`,
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
      // NO sourceTrustTier: comms-class already never auto-approves
      // (actionClassForProposalType), and omitting the tier keeps this on the
      // same always-review path as the polling worker's drafts.
    });

    return { proposal, taskType: this.taskType };
  }

  private async findPendingResponse(
    tenantId: string,
    reviewId: string,
  ): Promise<Proposal | undefined> {
    const pending = [
      ...(await this.proposalRepo.findByStatus(tenantId, 'draft')),
      ...(await this.proposalRepo.findByStatus(tenantId, 'ready_for_review')),
    ];
    return pending.find(
      (p) =>
        p.proposalType === 'review_response_proposal' &&
        (p.payload as { reviewId?: unknown }).reviewId === reviewId,
    );
  }

  /**
   * voice_clarification is the established "understood, but can't proceed —
   * tell the operator why" surface (same pattern as BatchInvoiceTaskHandler).
   */
  private clarify(context: TaskContext, message: string): TaskResult {
    return {
      proposal: createProposal({
        tenantId: context.tenantId,
        proposalType: 'voice_clarification',
        payload: {
          transcript: context.message,
          reason: 'missing_entities',
          classifierReasoning: message,
        },
        summary: message,
        sourceContext: context.conversationId
          ? { conversationId: context.conversationId }
          : undefined,
        createdBy: context.userId,
      }),
      taskType: 'voice_clarification',
    };
  }

  private clarifyAmbiguous(
    context: TaskContext,
    reference: string,
    candidates: Review[],
  ): TaskResult {
    return {
      proposal: createProposal({
        tenantId: context.tenantId,
        proposalType: 'voice_clarification',
        payload: {
          transcript: context.message,
          reason: 'ambiguous_entity',
          entityReference: reference,
          entityCandidates: candidates.map((r) => ({
            id: r.id,
            label: reviewLabel(r),
            hint: reviewHint(r),
            score: 1,
          })),
        },
        summary: `Which review? "${reference}" matched ${candidates.length} recent reviews`,
        explanation: `Heard the request, but ${candidates.length} recent reviews match. Tap the right one below.`,
        sourceContext: context.conversationId
          ? { conversationId: context.conversationId }
          : undefined,
        createdBy: context.userId,
      }),
      taskType: 'voice_clarification',
    };
  }
}
