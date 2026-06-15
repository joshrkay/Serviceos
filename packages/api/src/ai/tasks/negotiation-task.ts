/**
 * N-003 (P2-036) — negotiation guardrail task handler.
 *
 * Mirrors ComplaintTaskHandler (src/ai/tasks/complaint-task.ts). When the
 * intent classifier flags a `negotiation` intent (a customer pushing on price,
 * scope, or terms), the AI must not answer substantively. This handler turns
 * that into a single owner-facing `callback` proposal carrying the customer's
 * ask, the detected ask type, and a deterministic recommendation. The callback
 * is capture-class, so it lands in 'draft' and never auto-executes — the owner
 * decides on their terms and follows up.
 *
 * Reuses the existing `callback` proposal type (no new type, no migration),
 * exactly like the complaint handler reuses `callback` for owner follow-up.
 * Registered under the synthetic '_negotiation' key in the voice-action-router
 * (resolved by intent name, not proposal type).
 *
 * U5b (P2-036 V2) — when wired with a `settingsRepo` + `quoteResolver` AND we
 * resolved a customer, the handler ADDITIVELY consults the discount engine
 * (`evaluateNegotiationDiscount`) and branches on the decision:
 *   - null (unconfigured tenant / no quote / any error) → the V1 callback,
 *     BYTE-IDENTICAL to before.
 *   - CLARIFY → a `voice_clarification` (reason 'ambiguous_discount_target').
 *   - ALLOW → a CONFIDENCE-CAPPED `callback` (a one-tap owner action; never
 *     auto-applies — no executor exists).
 *   - NEEDS_APPROVAL / REJECT_WITH_COUNTER → the V1 callback, ENRICHED with the
 *     concrete figures.
 * Every branch is capture-class and lands in 'draft'. A best-effort audit event
 * (`negotiation.discount_evaluated`) is emitted per evaluated branch.
 */
import { createProposal } from '../../proposals/proposal';
import type { ProposalType } from '../../proposals/proposal';
import type { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import type { ExtractedEntities } from '../orchestration/intent-classifier';
import {
  buildNegotiationCallbackContent,
  evaluateNegotiationDiscount,
} from '../../proposals/guardrails/negotiation-guardrail';
import {
  buildAllowDiscountCallbackContent,
  buildDiscountClarificationPayload,
  discountAuditMetadata,
  DISCOUNT_CLARIFICATION_QUESTION,
} from '../../conversations/negotiation/discount-proposal-content';
import type { CurrentQuoteResolver } from '../../conversations/negotiation/current-quote-resolver';
import type { SettingsRepository } from '../../settings/settings';
import type { AuditRepository } from '../../audit/audit';
import { createAuditEvent } from '../../audit/audit';
import type { DiscountDecision } from '@ai-service-os/shared';
import type {
  CustomerNegotiationContext,
  CustomerNegotiationContextProvider,
} from '../../customers/customer-negotiation-context';

/**
 * U5b — optional deps that switch on the additive V2 discount-evaluation path.
 * Both `settingsRepo` and `quoteResolver` must be present (and a customer must
 * be resolved) for the path to run; otherwise the handler is V1-identical.
 */
export interface NegotiationDiscountDeps {
  settingsRepo?: Pick<SettingsRepository, 'findByTenant'>;
  quoteResolver?: CurrentQuoteResolver;
  /** Best-effort audit sink for `negotiation.discount_evaluated`. */
  auditRepo?: AuditRepository;
}

export class NegotiationGuardrailTaskHandler implements TaskHandler {
  // Reuses the capture-class `callback` proposal type. processSegment resolves
  // this handler by intent name ('negotiation'), not by proposal type, so the
  // taskType is just the proposal it emits.
  readonly taskType: ProposalType = 'callback';

  private readonly discountDeps: NegotiationDiscountDeps;

  constructor(
    private readonly contextProvider?: CustomerNegotiationContextProvider,
    discountDeps?: NegotiationDiscountDeps,
  ) {
    this.discountDeps = discountDeps ?? {};
  }

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = (context.existingEntities ?? {}) as ExtractedEntities & {
      customerId?: string;
      negotiationAsk?: string;
    };
    // Verified caller-ID identity wins, then router-resolved entities.
    const customerId = context.customerId ?? ee.customerId;
    const askText = ee.negotiationAsk ?? context.message;

    // Enrich the owner callback with the caller's LTV/recency when we resolved a
    // customer. Best-effort: a read failure never blocks the guardrail callback.
    let customerContext: CustomerNegotiationContext | null = null;
    if (customerId && this.contextProvider) {
      try {
        customerContext = await this.contextProvider.getContext(context.tenantId, customerId);
      } catch {
        customerContext = null;
      }
    }

    // Deterministic dedup so at-least-once redelivery of the same recording
    // never double-creates the proposal (parity with complaint-task). Preserved
    // across every branch below.
    const idempotencyKey = context.recordingId
      ? `voice-negotiation-callback:${context.recordingId}`
      : undefined;

    // U5b — additive discount evaluation (only when fully wired + a customer is
    // known). A null result keeps the V1 path byte-identical.
    const { settingsRepo, quoteResolver } = this.discountDeps;
    const evaluation =
      customerId && settingsRepo && quoteResolver
        ? await evaluateNegotiationDiscount({
            tenantId: context.tenantId,
            customerId,
            askText,
            settingsRepo,
            quoteResolver,
          })
        : null;

    if (evaluation) {
      await this.auditDecision(context, evaluation.decision, evaluation.quote.quotedCents);

      // CLARIFY — emit a one-tap voice_clarification instead of guessing.
      if (evaluation.decision.kind === 'CLARIFY') {
        const proposal = createProposal({
          tenantId: context.tenantId,
          proposalType: 'voice_clarification',
          payload: buildDiscountClarificationPayload({
            transcript: askText,
            ...(context.conversationId ? { conversationId: context.conversationId } : {}),
            ...(context.recordingId ? { recordingId: context.recordingId } : {}),
          }),
          summary: DISCOUNT_CLARIFICATION_QUESTION,
          explanation:
            'Heard a discount ask but couldn\'t make out the price they named. Tap to tell me what to quote — I never guess a discount.',
          sourceContext: {
            source: 'voice',
            ...(context.conversationId ? { conversationId: context.conversationId } : {}),
            ...(context.recordingId ? { recordingId: context.recordingId } : {}),
          },
          createdBy: context.userId,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(context.tenantThresholdOverride
            ? { tenantThresholdOverride: context.tenantThresholdOverride }
            : {}),
          // No sourceTrustTier: a clarification never auto-approves.
        });
        return { proposal, taskType: 'voice_clarification' };
      }

      // ALLOW — confidence-capped owner callback (one-tap; never auto-applies).
      if (evaluation.decision.kind === 'ALLOW') {
        const content = buildAllowDiscountCallbackContent({
          decision: evaluation.decision,
          quote: evaluation.quote,
          askText,
          ...(ee.customerName ? { customerName: ee.customerName } : {}),
          transcript: context.message,
          ...(context.conversationId ? { conversationId: context.conversationId } : {}),
        });
        const proposal = createProposal({
          tenantId: context.tenantId,
          proposalType: 'callback',
          payload: content.payload,
          summary: content.summary,
          explanation: content.explanation,
          sourceContext: {
            source: 'voice',
            ...(context.conversationId ? { conversationId: context.conversationId } : {}),
            ...(context.recordingId ? { recordingId: context.recordingId } : {}),
          },
          createdBy: context.userId,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(context.tenantThresholdOverride
            ? { tenantThresholdOverride: context.tenantThresholdOverride }
            : {}),
          // Deliberately NO sourceTrustTier; AND the payload _meta caps
          // confidence to 'low' so it can never auto-approve even if a future
          // caller threads a trust tier. One-tap owner action only.
        });
        return { proposal, taskType: 'callback' };
      }
    }

    // V1 path (unconfigured / no quote / NEEDS_APPROVAL / REJECT_WITH_COUNTER).
    // The decision (when present) ENRICHES the recommendation; when absent the
    // callback is byte-identical to V1.
    const enrichingDecision: DiscountDecision | undefined =
      evaluation &&
      (evaluation.decision.kind === 'NEEDS_APPROVAL' ||
        evaluation.decision.kind === 'REJECT_WITH_COUNTER')
        ? evaluation.decision
        : undefined;
    const content = buildNegotiationCallbackContent({
      detectText: context.message,
      askText,
      ...(ee.customerName ? { customerName: ee.customerName } : {}),
      transcript: context.message,
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      customerContext,
      ...(enrichingDecision ? { decision: enrichingDecision } : {}),
      ...(enrichingDecision && evaluation ? { quote: evaluation.quote } : {}),
    });

    const proposal = createProposal({
      tenantId: context.tenantId,
      proposalType: 'callback',
      payload: content.payload,
      summary: content.summary,
      explanation: content.explanation,
      sourceContext: {
        source: 'voice',
        ...(context.conversationId ? { conversationId: context.conversationId } : {}),
        ...(context.recordingId ? { recordingId: context.recordingId } : {}),
      },
      createdBy: context.userId,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
    });

    return { proposal, taskType: 'callback' };
  }

  /** Best-effort audit of an evaluated discount decision; never blocks. */
  private async auditDecision(
    context: TaskContext,
    decision: DiscountDecision,
    quotedCents: number,
  ): Promise<void> {
    const auditRepo = this.discountDeps.auditRepo;
    if (!auditRepo) return;
    try {
      await auditRepo.create(
        createAuditEvent({
          tenantId: context.tenantId,
          actorId: context.userId,
          actorRole: 'system',
          eventType: 'negotiation.discount_evaluated',
          entityType: 'proposal',
          entityId: context.recordingId ?? context.conversationId ?? context.tenantId,
          metadata: discountAuditMetadata(decision, quotedCents),
        }),
      );
    } catch {
      /* audit is best-effort */
    }
  }
}
