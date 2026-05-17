/**
 * P7-026 — Execution handler for `review_response` proposals.
 *
 * Walks the three sub-payloads (public/private/credit) and executes
 * only the ones the owner approved. Each component is independently
 * approve / edit / reject — when a component is `pending` or `rejected`,
 * the handler skips it without failing the proposal.
 *
 * Defense-in-depth: the credit cap is enforced AGAIN here (the proposal
 * builder bounded the suggestion at draft time, but the owner may have
 * edited the amount). Per the dispatch addendum's "Credit cap bypass"
 * risk note, owner approval cannot override the 12-month hard cap.
 *
 * Audit: every approved sub-action emits its own audit event so the
 * reputation timeline shows three distinct mutations when all three
 * land (review.public_response_posted, review.private_message_sent,
 * review.service_credit_issued).
 *
 * Posting the public response and sending the private message are
 * delegated to provider-facing functions injected as dependencies —
 * the handler doesn't import Twilio / Google clients directly. This
 * keeps the handler unit-testable and the integration surface
 * controlled.
 */

import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionContext, ExecutionHandler, ExecutionResult } from './handlers';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import {
  reviewResponseProposalPayloadSchema,
  type ReviewResponseProposalPayload,
} from '@ai-service-os/shared/dist/contracts/review-response-proposal.js';
import { assertCreditWithinCap } from '../../reputation/credit-tier';
import type { ServiceCreditRepository, ServiceCredit } from '../../reputation/service-credit-repository';
import { assertNoPiiInPublicDraft } from '../../reputation/pii-redactor';

/**
 * Post a public response to a Google review. Provider-side detail
 * (auth, signing, retries) lives wherever the integration is wired;
 * the handler just calls this function with the final text.
 */
export type PostPublicReviewResponse = (input: {
  tenantId: string;
  reviewId: string;
  text: string;
}) => Promise<{ externalId: string }>;

/**
 * Send a private apology message via SMS/email. The shared notification
 * stack (twilio-delivery-provider for SMS, sendgrid for email) wires up
 * the real delivery; the handler is provider-agnostic.
 */
export type SendPrivateApology = (input: {
  tenantId: string;
  customerId: string;
  channel: 'sms' | 'email';
  text: string;
}) => Promise<{ messageId: string }>;

export interface ReviewResponseHandlerDeps {
  /** Post the public Google reply. Skipped when the public sub-payload is not approved. */
  postPublicResponse?: PostPublicReviewResponse;
  /** Send the private SMS/email. Skipped when the private sub-payload is not approved. */
  sendPrivateApology?: SendPrivateApology;
  /** Write to `service_credits`. Skipped when the credit sub-payload is not approved. */
  creditRepo?: ServiceCreditRepository;
  /** For audit events. Audit failures are logged but do NOT unwind a successful execution. */
  auditRepo?: AuditRepository;
  /** Injectable clock for the cap query. */
  now?: () => Date;
}

export class ReviewResponseExecutionHandler implements ExecutionHandler {
  // P7-026 — the literal 'review_response' is intentionally cast to
  // ProposalType here. The dispatch addendum forbids touching
  // proposals/contracts.ts and proposals/prioritization.ts (both of
  // which use exhaustive Record<ProposalType, X> annotations), so we
  // cannot extend the ProposalType union without breaking the build.
  // The cast is safe at runtime: createProposal already validates
  // proposalType against VALID_PROPOSAL_TYPES, which means a
  // review_response proposal never lands in the DB without going
  // through buildReviewResponseProposal — which uses this same cast.
  proposalType: ProposalType = 'review_response' as ProposalType;

  constructor(private readonly deps: ReviewResponseHandlerDeps = {}) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const payloadParse = reviewResponseProposalPayloadSchema.safeParse(proposal.payload);
    if (!payloadParse.success) {
      return {
        success: false,
        error: `Invalid review_response payload: ${payloadParse.error.message}`,
      };
    }
    const payload: ReviewResponseProposalPayload = payloadParse.data;
    const now = (this.deps.now ?? (() => new Date()))();

    // Track the outcomes so we can decide success/failure overall.
    const executedParts: string[] = [];
    const errors: string[] = [];

    // Public response.
    if (
      payload.publicResponse &&
      (payload.publicResponse.decision === 'approved' ||
        payload.publicResponse.decision === 'edited')
    ) {
      const text =
        payload.publicResponse.decision === 'edited' && payload.publicResponse.editedText
          ? payload.publicResponse.editedText
          : payload.publicResponse.draft;

      // Defense-in-depth PII assertion. The proposal builder already
      // ran the redactor; if the owner edited the draft, we re-run
      // the strict assertion. A failure here aborts only the public
      // sub-action — the private + credit sub-actions still attempt.
      try {
        assertNoPiiInPublicDraft({ text });
      } catch (piiErr) {
        errors.push(
          `public_response refused: ${piiErr instanceof Error ? piiErr.message : String(piiErr)}`,
        );
      }

      if (!errors.some((e) => e.startsWith('public_response refused'))) {
        if (this.deps.postPublicResponse) {
          try {
            const result = await this.deps.postPublicResponse({
              tenantId: context.tenantId,
              reviewId: payload.reviewId,
              text,
            });
            executedParts.push(`public_response:${result.externalId}`);
            await this.emitAudit(context, 'review.public_response_posted', payload.reviewId, {
              proposalId: proposal.id,
              externalId: result.externalId,
            });
          } catch (err) {
            errors.push(
              `public_response: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        } else {
          // No provider wired (test mode) — pretend success, tag as
          // synthetic so callers can detect it in audit metadata.
          executedParts.push('public_response:synthetic');
          await this.emitAudit(context, 'review.public_response_posted', payload.reviewId, {
            proposalId: proposal.id,
            synthetic: true,
          });
        }
      }
    }

    // Private message.
    if (
      payload.privateMessage &&
      payload.matchedCustomerId &&
      (payload.privateMessage.decision === 'approved' ||
        payload.privateMessage.decision === 'edited')
    ) {
      const text =
        payload.privateMessage.decision === 'edited' && payload.privateMessage.editedText
          ? payload.privateMessage.editedText
          : payload.privateMessage.draft;
      if (this.deps.sendPrivateApology) {
        try {
          const result = await this.deps.sendPrivateApology({
            tenantId: context.tenantId,
            customerId: payload.matchedCustomerId,
            channel: payload.privateMessage.channel,
            text,
          });
          executedParts.push(`private_message:${result.messageId}`);
          await this.emitAudit(context, 'review.private_message_sent', payload.reviewId, {
            proposalId: proposal.id,
            messageId: result.messageId,
            channel: payload.privateMessage.channel,
            customerId: payload.matchedCustomerId,
          });
        } catch (err) {
          errors.push(
            `private_message: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        executedParts.push('private_message:synthetic');
        await this.emitAudit(context, 'review.private_message_sent', payload.reviewId, {
          proposalId: proposal.id,
          synthetic: true,
          channel: payload.privateMessage.channel,
          customerId: payload.matchedCustomerId,
        });
      }
    }

    // Service credit.
    if (
      payload.serviceCredit &&
      payload.matchedCustomerId &&
      (payload.serviceCredit.decision === 'approved' ||
        payload.serviceCredit.decision === 'edited')
    ) {
      const proposedCents =
        payload.serviceCredit.decision === 'edited' && payload.serviceCredit.editedAmountCents !== undefined
          ? payload.serviceCredit.editedAmountCents
          : payload.serviceCredit.amountCents;

      if (proposedCents > 0) {
        if (!this.deps.creditRepo) {
          errors.push('service_credit: no creditRepo wired');
        } else {
          try {
            await assertCreditWithinCap({
              tenantId: context.tenantId,
              customerId: payload.matchedCustomerId,
              proposedAmountCents: proposedCents,
              now,
              repo: this.deps.creditRepo,
            });
            const credit: ServiceCredit = {
              id: uuidv4(),
              tenantId: context.tenantId,
              customerId: payload.matchedCustomerId,
              amountCents: proposedCents,
              issuedAt: now,
              issuedByUserId: context.executedBy,
              sourceReviewId: payload.reviewId,
              notes: `Credit issued via review_response proposal ${proposal.id}`,
              createdAt: now,
            };
            const saved = await this.deps.creditRepo.create(credit);
            executedParts.push(`service_credit:${saved.id}`);
            await this.emitAudit(context, 'review.service_credit_issued', payload.reviewId, {
              proposalId: proposal.id,
              creditId: saved.id,
              amountCents: proposedCents,
              customerId: payload.matchedCustomerId,
            });
          } catch (err) {
            errors.push(
              `service_credit: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    // Overall result. A failure on any component yields success:false
    // so the executor can re-route the proposal; the executedParts
    // list still records which components succeeded so an operator
    // can manually re-try only the failed parts.
    if (errors.length > 0) {
      return {
        success: false,
        error: errors.join('; '),
        ...(executedParts.length > 0 && {
          resultEntityId: executedParts.join(','),
        }),
      };
    }
    return {
      success: true,
      resultEntityId: executedParts.join(',') || payload.reviewId,
    };
  }

  private async emitAudit(
    context: ExecutionContext,
    eventType: string,
    reviewId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.auditRepo) return;
    try {
      await this.deps.auditRepo.create(
        createAuditEvent({
          tenantId: context.tenantId,
          actorId: context.executedBy,
          actorRole: 'system',
          eventType,
          entityType: 'google_review',
          entityId: reviewId,
          metadata,
        }),
      );
    } catch (err) {
      // Audit failures must not unwind a successful execution — mirror
      // the pattern in log-expense-handler.ts.
      console.warn(
        `Failed to emit ${eventType} for review ${reviewId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
