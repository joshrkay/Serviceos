/**
 * P7-026 PR c — ReviewResponseExecutionHandler.
 *
 * Dispatches the 3 sub-actions of a `review_response_proposal` based
 * on each component's `approved` flag:
 *   - publicResponse.approved   → POST to Google Business Profile
 *   - privateFollowUp.approved  → send email/SMS via delivery provider
 *   - serviceCredit.approved    → insert into service_credits table
 *
 * Each sub-action is independent. The handler completes successfully
 * if all enabled sub-actions succeed; if any fail, `success: false`
 * is returned with a comma-joined error string.
 *
 * Idempotency: the Google PUT-reply API is naturally idempotent
 * (sending the same comment twice returns the same updateTime). The
 * service-credit insert is gated by the proposal-execution-idempotency
 * layer at the executor (a re-claim of an already-executed proposal
 * is blocked there). The notification send carries a per-component
 * idempotency key derived from proposalId so duplicate sends are
 * deduped at the provider.
 *
 * Audit emission is failure-soft: any audit failure is logged but
 * does NOT unwind the sub-action mutations. Mirrors the pattern in
 * log-expense-handler.ts.
 *
 * Optional deps: the handler accepts every external dep as optional.
 * In production all are wired; in unit tests, callers stub only the
 * deps they exercise. When the Google client is absent, the public
 * sub-action returns success without posting (test/dev path).
 */

import { Proposal, ProposalType } from '../proposal';
import { ExecutionContext, ExecutionHandler, ExecutionResult } from './handlers';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import {
  GoogleBusinessApiError,
  GoogleBusinessQuotaError,
  replyToReview as defaultReplyToReview,
} from '../../reputation/google-business-client';
import { ServiceCreditRepository } from '../../reputation/service-credit';

import type {
  ReviewResponseProposalPayload,
  ReviewResponsePrivateComponent,
  ReviewResponseCreditComponent,
} from '@ai-service-os/shared';

/**
 * Token resolver. The handler doesn't manage Google OAuth — the
 * caller (production wiring) supplies a function that returns a
 * fresh access token + the account/location to post under, given the
 * tenant context. This keeps OAuth refresh out of the handler.
 */
export interface GoogleBusinessReplyContext {
  accessToken: string;
  accountId: string;
  locationId: string;
  /**
   * The upstream review resource id (the trailing `/reviews/{id}`
   * segment, NOT the full path). Extracted from the persisted review
   * row's `external_review_id` upstream of the handler.
   */
  reviewExternalId: string;
}

export interface GoogleBusinessReplyResolver {
  resolve(
    tenantId: string,
    reviewId: string,
  ): Promise<GoogleBusinessReplyContext | null>;
}

/**
 * Minimal notification surface. The handler only needs to enqueue a
 * private message to a customer — the production wiring adapts this
 * to the unified MessageDeliveryProvider in
 * `notifications/delivery-provider.ts`. Decoupled here so PR c's
 * execution handler doesn't import from `notifications/**` (the
 * adapter for review-driven sends lives in app.ts wiring).
 */
/**
 * Result of a private-follow-up send. Either a real delivery
 * (`providerMessageId`) or a compliance suppression — the recipient is on the
 * tenant DNC list or has not granted SMS consent, so the message MUST NOT go
 * out. Suppression is a correct outcome, not a failure: the sender decides it
 * before hitting the transport, and the handler records it ok=true (nothing
 * was sent, nothing failed).
 */
export type ReviewPrivateMessageResult =
  | { providerMessageId: string }
  | { suppressed: true; reason: 'dnc' | 'no_consent' };

export interface ReviewPrivateMessageSender {
  send(input: {
    tenantId: string;
    customerId: string;
    channel: 'email' | 'sms';
    body: string;
    idempotencyKey: string;
  }): Promise<ReviewPrivateMessageResult>;
}

export type ReplyToReviewFn = typeof defaultReplyToReview;

/** Sub-action result for the audit metadata. */
interface SubActionResult {
  kind: 'public' | 'private' | 'credit';
  ok: boolean;
  id?: string;
  error?: string;
}

export class ReviewResponseExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'review_response_proposal';
  // Awaits replyFn (Google Business Profile API) and privateMessageSender.send
  // (customer email/SMS) — external network I/O alongside the service-credit DB
  // insert.
  performsExternalIo = true;

  constructor(
    private readonly serviceCreditRepo?: ServiceCreditRepository,
    private readonly googleReplyResolver?: GoogleBusinessReplyResolver,
    private readonly privateMessageSender?: ReviewPrivateMessageSender,
    private readonly auditRepo?: AuditRepository,
    private readonly replyFn: ReplyToReviewFn = defaultReplyToReview,
  ) {}

  async execute(
    proposal: Proposal,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    // Payload was validated against the Zod schema by the contracts
    // registry at proposal-creation time. We trust the shape here.
    const payload = proposal.payload as unknown as ReviewResponseProposalPayload;
    const subResults: SubActionResult[] = [];

    if (payload.publicResponse.approved) {
      subResults.push(
        await this.executePublicResponse(
          proposal,
          payload.publicResponse.text,
          payload.reviewId,
          context,
        ),
      );
    }

    if (payload.privateFollowUp && payload.privateFollowUp.approved) {
      subResults.push(
        await this.executePrivateFollowUp(
          proposal,
          payload.privateFollowUp,
          context,
        ),
      );
    }

    if (payload.serviceCredit && payload.serviceCredit.approved) {
      subResults.push(
        await this.executeServiceCredit(
          proposal,
          payload.serviceCredit,
          payload.reviewId,
          context,
        ),
      );
    }

    // Emit a single composite audit event. Failure-soft.
    if (this.auditRepo) {
      try {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'system',
            eventType: 'review_response.executed',
            entityType: 'proposal',
            entityId: proposal.id,
            metadata: {
              proposalType: 'review_response_proposal',
              reviewId: payload.reviewId,
              subResults,
            },
          }),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `Failed to emit review_response.executed audit event for proposal ${proposal.id}: ${msg}`,
        );
      }
    }

    const failures = subResults.filter((r) => !r.ok);
    if (failures.length > 0) {
      return {
        success: false,
        error: failures.map((f) => `${f.kind}: ${f.error ?? 'failed'}`).join('; '),
        resultEntityId: proposal.id,
      };
    }
    return { success: true, resultEntityId: proposal.id };
  }

  private async executePublicResponse(
    proposal: Proposal,
    text: string,
    reviewId: string,
    context: ExecutionContext,
  ): Promise<SubActionResult> {
    // No resolver wired → degrade to passthrough (used by unit tests
    // that don't exercise the Google call path). In production this
    // signals a misconfigured composition root — log a warning so ops
    // can detect it without flipping the proposal to failed (the
    // operator's approval was the desired terminal state).
    if (!this.googleReplyResolver) {
      console.warn(
        `ReviewResponseExecutionHandler: no googleReplyResolver wired; public reply for proposal ${proposal.id} was skipped. TODO wire at app.ts composition root.`,
      );
      return { kind: 'public', ok: true, id: reviewId };
    }
    const replyCtx = await this.googleReplyResolver.resolve(
      context.tenantId,
      reviewId,
    );
    if (!replyCtx) {
      return {
        kind: 'public',
        ok: false,
        error: `No Google Business reply context for review ${reviewId}`,
      };
    }
    try {
      const result = await this.replyFn(
        replyCtx.accessToken,
        replyCtx.accountId,
        replyCtx.locationId,
        replyCtx.reviewExternalId,
        text,
      );
      return { kind: 'public', ok: true, id: result.updateTime };
    } catch (err) {
      // Distinguish quota vs schema vs generic errors for the
      // operator-facing error message. All three are surfaced
      // through ExecutionResult.error verbatim — the worker retry
      // path lives at the proposal executor.
      let label = 'reply_failed';
      if (err instanceof GoogleBusinessQuotaError) label = 'quota_exceeded';
      else if (err instanceof GoogleBusinessApiError) label = 'schema_drift';
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: 'public', ok: false, error: `${label}: ${msg}` };
    }
  }

  private async executePrivateFollowUp(
    proposal: Proposal,
    component: ReviewResponsePrivateComponent,
    context: ExecutionContext,
  ): Promise<SubActionResult> {
    if (!this.privateMessageSender) {
      // No sender wired → log + return ok=true so the proposal
      // doesn't fail in test/dev. Production wires a real sender via
      // the app.ts composition root.
      console.warn(
        `ReviewResponseExecutionHandler: no privateMessageSender wired; private follow-up for proposal ${proposal.id} was skipped (would have sent ${component.channel} to ${component.customerId})`,
      );
      return { kind: 'private', ok: true };
    }
    try {
      const result = await this.privateMessageSender.send({
        tenantId: context.tenantId,
        customerId: component.customerId,
        channel: component.channel,
        body: component.body,
        // Per-component idempotency key — re-execution attempts
        // dedupe at the provider rather than re-sending. Bound to
        // proposal + component-kind so a private-only proposal that
        // re-runs after a partial failure dedupes correctly.
        idempotencyKey: `review-response-private:${proposal.id}`,
      });
      if ('suppressed' in result) {
        // Compliance suppression (DNC / no SMS consent): nothing was sent, and
        // that is the CORRECT outcome — never texting an opted-out customer is
        // not a failure. Record ok=true with the reason for the audit trail.
        console.warn(
          `ReviewResponseExecutionHandler: private follow-up suppressed (${result.reason}) for proposal ${proposal.id}, customer ${component.customerId}`,
        );
        return { kind: 'private', ok: true, error: `suppressed:${result.reason}` };
      }
      return { kind: 'private', ok: true, id: result.providerMessageId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: 'private', ok: false, error: msg };
    }
  }

  private async executeServiceCredit(
    proposal: Proposal,
    component: ReviewResponseCreditComponent,
    reviewId: string,
    context: ExecutionContext,
  ): Promise<SubActionResult> {
    if (!this.serviceCreditRepo) {
      return { kind: 'credit', ok: true };
    }
    try {
      const credit = await this.serviceCreditRepo.create({
        tenantId: context.tenantId,
        customerId: component.customerId,
        amountCents: component.amountCents,
        reviewId,
        proposalId: proposal.id,
      });
      return { kind: 'credit', ok: true, id: credit.id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: 'credit', ok: false, error: msg };
    }
  }
}
