/**
 * N-003 (P2-036) — inbound-SMS negotiation guardrail.
 *
 * The text-channel counterpart to the voice guardrail. Consulted by the
 * inbound-SMS dispatcher LAST (after keyword routing, the owner-edit fallback,
 * and dropped-call recovery all decline), so it only ever sees genuinely
 * unclaimed customer free-text. When the message is a negotiation ask
 * (discount / scope-change / refund-as-leverage / manager escalation /
 * deadline threat), the AI does NOT answer substantively: it
 *
 *   1. creates an owner `callback` proposal with the ask + a recommendation
 *      (capture-class → 'draft', never auto-executes), and
 *   2. replies to the customer with a brand-voiced holding line.
 *
 * Both the proposal content and the holding line are shared with the voice
 * surface (proposals/guardrails/negotiation-guardrail.ts +
 * conversations/negotiation/acknowledgment.ts).
 */
import type { InboundSmsContext, HandlerResult, FallbackHandler } from '../inbound-dispatch';
import { createProposal } from '../../proposals/proposal';
import type { ProposalRepository } from '../../proposals/proposal';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import type { Logger } from '../../logging/logger';
import type { BrandVoiceSettings } from '../../settings/settings';
import {
  detectNegotiationAskType,
  buildNegotiationCallbackContent,
} from '../../proposals/guardrails/negotiation-guardrail';
import {
  buildAllowDiscountCallbackContent,
  buildDiscountClarificationPayload,
  discountAuditMetadata,
  DISCOUNT_CLARIFICATION_QUESTION,
} from '../../conversations/negotiation/discount-proposal-content';
import { composeNegotiationAcknowledgment } from '../../conversations/negotiation/acknowledgment';
import type { CustomerNegotiationContext } from '../../customers/customer-negotiation-context';
import type { CurrentQuote } from '../../conversations/negotiation/current-quote-resolver';
import type { DiscountDecision } from '@ai-service-os/shared';

export interface NegotiationBrandContext {
  ownerFirstName?: string | null;
  brandVoice?: BrandVoiceSettings | null;
  businessName?: string;
}

export interface InboundNegotiationDeps {
  proposalRepo: Pick<ProposalRepository, 'create'>;
  /**
   * Reply transport (same delivery provider the other inbound handlers use).
   * tenantId is forwarded so the central consent+DNC gate can resolve the
   * customer + per-tenant DNC (WS1).
   */
  sendSms: (args: { to: string; body: string; tenantId?: string }) => Promise<unknown>;
  auditRepo?: AuditRepository;
  /** Per-tenant brand voice / owner name for the holding line. */
  resolveBrandContext?: (tenantId: string) => Promise<NegotiationBrandContext>;
  /**
   * Resolve the caller's LTV/recency from their phone (E.164). Returns null when
   * the phone matches zero or multiple customers (no silent guess). When unwired
   * the owner callback falls back to a generic recommendation.
   */
  resolveCustomerContext?: (
    tenantId: string,
    phoneE164: string,
  ) => Promise<CustomerNegotiationContext | null>;
  /**
   * U5b (P2-036 V2) — OPTIONAL additive discount evaluation. app.ts wires a
   * closure that resolves phone → customerId (V1 `findByPhoneNormalized`) →
   * `evaluateNegotiationDiscount`. Returns null for an unconfigured tenant, no
   * resolvable quote, an unresolved phone, or any error — in which case the
   * handler is BYTE-IDENTICAL to V1. When non-null, the handler branches on the
   * decision (CLARIFY / ALLOW / NEEDS_APPROVAL / REJECT_WITH_COUNTER). Best-
   * effort: the closure must not throw (it swallows its own errors to null).
   */
  evaluateDiscount?: (
    tenantId: string,
    phoneE164: string,
    askText: string,
  ) => Promise<{ decision: DiscountDecision; quote: CurrentQuote } | null>;
  systemActorId?: string;
  logger?: Logger;
}

export function createInboundNegotiationHandler(
  deps: InboundNegotiationDeps,
): FallbackHandler {
  const actorId = deps.systemActorId ?? 'system:negotiation-guardrail';

  async function audit(
    ctx: InboundSmsContext,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!deps.auditRepo) return;
    try {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: ctx.tenantId,
          actorId,
          actorRole: 'system',
          eventType: 'negotiation_guardrail.sms_routed',
          entityType: 'sms_message',
          entityId: ctx.messageSid,
          metadata,
        }),
      );
    } catch {
      /* audit is best-effort */
    }
  }

  return {
    name: 'negotiation-guardrail',
    async handle(ctx: InboundSmsContext): Promise<HandlerResult> {
      const askType = detectNegotiationAskType(ctx.body);
      if (askType === null) {
        return {
          handled: false,
          handler: 'negotiation-guardrail',
          reason: 'no_negotiation_detected',
        };
      }

      let brand: NegotiationBrandContext = {};
      if (deps.resolveBrandContext) {
        try {
          brand = await deps.resolveBrandContext(ctx.tenantId);
        } catch {
          /* fall back to defaults — the composer tolerates an empty context */
        }
      }

      let customerContext: CustomerNegotiationContext | null = null;
      if (deps.resolveCustomerContext) {
        try {
          customerContext = await deps.resolveCustomerContext(ctx.tenantId, ctx.fromE164);
        } catch {
          /* best-effort enrichment — the callback still ships without it */
        }
      }

      // U5b — additive discount evaluation. null (unconfigured / no quote /
      // unresolved phone / error) keeps this handler BYTE-IDENTICAL to V1.
      let evaluation: { decision: DiscountDecision; quote: CurrentQuote } | null = null;
      if (deps.evaluateDiscount) {
        try {
          evaluation = await deps.evaluateDiscount(ctx.tenantId, ctx.fromE164, ctx.body);
        } catch {
          /* best-effort — degrade to the V1 owner callback */
        }
      }
      if (evaluation) {
        await audit(ctx, discountAuditMetadata(evaluation.decision, evaluation.quote.quotedCents));
      }

      // Build the proposal for the resolved branch. Every branch is capture-
      // class and lands in 'draft'; the customer always gets a holding line,
      // never a concession.
      const built = buildNegotiationProposalContent({
        ctx,
        customerContext,
        evaluation,
      });

      let proposalId: string | undefined;
      try {
        const proposal = createProposal({
          tenantId: ctx.tenantId,
          proposalType: built.proposalType,
          payload: built.payload,
          summary: built.summary,
          explanation: built.explanation,
          sourceContext: { source: 'sms', fromPhone: ctx.fromE164, messageSid: ctx.messageSid },
          createdBy: actorId,
          // Twilio dedups the inbound receipt upstream; this is belt-and-braces.
          idempotencyKey: `sms-negotiation-callback:${ctx.messageSid}`,
          // No sourceTrustTier on any branch: the ALLOW callback is also
          // confidence-capped ('low' in its _meta) so it can never auto-approve.
        });
        const stored = await deps.proposalRepo.create(proposal);
        proposalId = stored.id;
      } catch (err) {
        deps.logger?.warn('negotiation-guardrail: owner callback create failed', {
          tenantId: ctx.tenantId,
          messageSid: ctx.messageSid,
          error: err instanceof Error ? err.message : String(err),
        });
        // Still acknowledge: the AI must not negotiate even if the heads-up
        // failed to persist. The owner can also see the inbound message itself.
      }

      const body = composeNegotiationAcknowledgment({
        ownerFirstName: brand.ownerFirstName ?? null,
        brandVoice: brand.brandVoice ?? null,
        businessName: brand.businessName ?? null,
      });
      await deps.sendSms({ to: ctx.fromE164, body, tenantId: ctx.tenantId });

      await audit(ctx, {
        askType: built.auditAskType,
        proposalId: proposalId ?? null,
      });

      return { handled: true, handler: 'negotiation-guardrail' };
    },
  };
}

interface BuiltNegotiationProposal {
  proposalType: 'callback' | 'voice_clarification';
  payload: Record<string, unknown>;
  summary: string;
  explanation: string;
  /** Value stamped on the `sms_routed` audit event's `askType` field. */
  auditAskType: string;
}

/**
 * U5b — pick the proposal content for the resolved branch. Mirrors the
 * voice-task handler so both surfaces emit byte-identical payloads:
 *   - CLARIFY → a voice_clarification (reason 'ambiguous_discount_target');
 *   - ALLOW → a confidence-capped callback (one-tap; never auto-applies);
 *   - NEEDS_APPROVAL / REJECT_WITH_COUNTER → the V1 callback, enriched;
 *   - no evaluation → the V1 callback, BYTE-IDENTICAL.
 * The caller's phone is always stamped so the owner can call back.
 */
function buildNegotiationProposalContent(args: {
  ctx: InboundSmsContext;
  customerContext: CustomerNegotiationContext | null;
  evaluation: { decision: DiscountDecision; quote: CurrentQuote } | null;
}): BuiltNegotiationProposal {
  const { ctx, customerContext, evaluation } = args;

  if (evaluation?.decision.kind === 'CLARIFY') {
    return {
      proposalType: 'voice_clarification',
      payload: buildDiscountClarificationPayload({ transcript: ctx.body }),
      summary: DISCOUNT_CLARIFICATION_QUESTION,
      explanation:
        'Heard a discount ask over text but couldn\'t make out the price they named. Tap to tell me what to quote — I never guess a discount.',
      auditAskType: 'discount',
    };
  }

  if (evaluation?.decision.kind === 'ALLOW') {
    const content = buildAllowDiscountCallbackContent({
      decision: evaluation.decision,
      quote: evaluation.quote,
      askText: ctx.body,
      transcript: ctx.body,
      callerPhone: ctx.fromE164,
    });
    return {
      proposalType: 'callback',
      payload: content.payload,
      summary: content.summary,
      explanation: content.explanation,
      auditAskType: 'discount',
    };
  }

  // V1 path (no evaluation / NEEDS_APPROVAL / REJECT_WITH_COUNTER). The
  // decision (when present) ENRICHES the recommendation; absent → V1-identical.
  const enrichingDecision =
    evaluation &&
    (evaluation.decision.kind === 'NEEDS_APPROVAL' ||
      evaluation.decision.kind === 'REJECT_WITH_COUNTER')
      ? evaluation.decision
      : undefined;
  const content = buildNegotiationCallbackContent({
    detectText: ctx.body,
    askText: ctx.body,
    transcript: ctx.body,
    customerContext,
    ...(enrichingDecision ? { decision: enrichingDecision } : {}),
    ...(enrichingDecision && evaluation ? { quote: evaluation.quote } : {}),
  });
  return {
    proposalType: 'callback',
    payload: { ...content.payload, callerPhone: ctx.fromE164 },
    summary: content.summary,
    explanation: content.explanation,
    auditAskType: content.askType ?? 'general',
  };
}
