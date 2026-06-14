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
import { composeNegotiationAcknowledgment } from '../../conversations/negotiation/acknowledgment';

export interface NegotiationBrandContext {
  ownerFirstName?: string | null;
  brandVoice?: BrandVoiceSettings | null;
  businessName?: string;
}

export interface InboundNegotiationDeps {
  proposalRepo: Pick<ProposalRepository, 'create'>;
  /** Reply transport (same delivery provider the other inbound handlers use). */
  sendSms: (args: { to: string; body: string }) => Promise<unknown>;
  auditRepo?: AuditRepository;
  /** Per-tenant brand voice / owner name for the holding line. */
  resolveBrandContext?: (tenantId: string) => Promise<NegotiationBrandContext>;
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

      const content = buildNegotiationCallbackContent({
        detectText: ctx.body,
        askText: ctx.body,
        transcript: ctx.body,
      });

      let proposalId: string | undefined;
      try {
        const proposal = createProposal({
          tenantId: ctx.tenantId,
          proposalType: 'callback',
          payload: { ...content.payload, callerPhone: ctx.fromE164 },
          summary: content.summary,
          explanation: content.explanation,
          sourceContext: { source: 'sms', fromPhone: ctx.fromE164, messageSid: ctx.messageSid },
          createdBy: actorId,
          // Twilio dedups the inbound receipt upstream; this is belt-and-braces.
          idempotencyKey: `sms-negotiation-callback:${ctx.messageSid}`,
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
      await deps.sendSms({ to: ctx.fromE164, body });

      await audit(ctx, {
        askType: content.askType ?? 'general',
        proposalId: proposalId ?? null,
      });

      return { handled: true, handler: 'negotiation-guardrail' };
    },
  };
}
