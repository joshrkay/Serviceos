/**
 * P2-034 / TCPA — the `YES` keyword is shared between two features:
 *
 *   • Compliance re-opt-in: a customer who texted STOP can reply
 *     START / UNSTOP / YES to opt back in (carrier-mirrored, legally
 *     required — see compliance/stop-reply.ts).
 *   • Proposal approval: YES is also the owner's most natural approve
 *     reply.
 *
 * Registering the proposal handler over `yes` (as the first cut of this
 * feature did, via `overwrite: true`) silently broke opt-in. This
 * composite keeps compliance primary and layers approval on top:
 *
 *   1. If the sender was on the DNC list, the message IS the opt-in:
 *      remove them and stop — an opt-in can never approve work, even
 *      when the sender is the owner with a proposal pending.
 *   2. Otherwise run the compliance removal anyway (no-op, preserves
 *      the pre-existing start-reply behavior exactly), then give the
 *      proposal reply handler a shot. START/UNSTOP parse as
 *      `unrecognized` there, so only YES can reach an approval.
 */
import {
  START_KEYWORDS,
  buildStartKeywordHandler,
} from '../../compliance/stop-reply';
import { type DncRepository, normalizePhone } from '../../compliance/dnc';
import type { KeywordHandler, InboundSmsContext, HandlerResult } from '../../sms/inbound-dispatch';

export function buildStartOrApproveKeywordHandler(deps: {
  dncRepo: DncRepository;
  proposalReplyHandler: KeywordHandler;
}): KeywordHandler {
  const startHandler = buildStartKeywordHandler({ dncRepo: deps.dncRepo });
  return {
    keywords: START_KEYWORDS,
    async handle(ctx: InboundSmsContext): Promise<HandlerResult> {
      const wasOnDnc = await deps.dncRepo.isOnDnc(
        ctx.tenantId,
        normalizePhone(ctx.fromE164),
      );
      const complianceResult = await startHandler.handle(ctx);
      if (wasOnDnc) {
        // A real opt-in. Never double as an approval.
        return { ...complianceResult, reason: 'opted_back_in' };
      }
      const viaProposal = await deps.proposalReplyHandler.handle(ctx);
      return viaProposal.handled ? viaProposal : complianceResult;
    },
  };
}
