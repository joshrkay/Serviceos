/**
 * Shared "customer protection" proposal glue — negotiation and complaint.
 *
 * The FSM (ai/agents/customer-calling/transitions.ts) emits a channel-
 * agnostic `create_proposal` side effect with `{intent: 'negotiation' |
 * 'complaint', entities, ...}` for BOTH live voice surfaces: the S1
 * telephony caller (ai/voice-turn/create-voice-turn-processor.ts) and the
 * S2 in-app operator session (ai/agents/customer-calling/inapp-adapter.ts).
 * Neither intent is in `proposals/voice-intent-map.ts` — that map's
 * documented DEFAULT for an unmapped intent is `voice_clarification` — so
 * whichever adapter handles the side effect MUST intercept these two
 * intents itself, before falling through to the generic
 * `intentToProposalType` lookup, or the caller/operator gets a dead
 * `voice_clarification` card with no execution handler instead of the
 * dedicated owner `callback`.
 *
 * This glue used to be written TWICE (#883 on the telephony path only);
 * the in-app adapter had no equivalent branch, so a live "I'm really
 * unhappy" / "knock $50 off" on the trusted in-app surface minted
 * `voice_clarification` anyway (sweep rows A49/A50, 2026-08-30) — the
 * EXACT drift `voice-intent-map.ts`'s own history comment warns a second
 * copy invites. One core, thin adapters (D-026 precedent): both surfaces
 * now call the same two functions below, passing only what differs
 * (channel, surface, session id, createdBy).
 */
import type { Proposal, ProposalRepository } from '../proposal';
import { createProposal as buildProposal } from '../proposal';
import type { ProposalSurface } from '../surface';
import {
  buildNegotiationCallbackContent,
  evaluateNegotiationDiscount,
} from './negotiation-guardrail';
import { buildComplaintCallbackContent } from './complaint-guardrail';
import {
  buildAllowDiscountCallbackContent,
  buildDiscountClarificationPayload,
  discountAuditMetadata,
} from '../../conversations/negotiation/discount-proposal-content';
import type { CurrentQuoteResolver } from '../../conversations/negotiation/current-quote-resolver';
import type {
  CustomerNegotiationContext,
  CustomerNegotiationContextProvider,
} from '../../customers/customer-negotiation-context';
import type { AuditRepository } from '../../audit/audit';
import { createAuditEvent } from '../../audit/audit';
import type { SettingsRepository } from '../../settings/settings';

/** What differs between the two live voice adapters for this turn. */
export interface ProtectionProposalCallContext {
  tenantId: string;
  sessionId: string;
  channel: 'telephony' | 'inapp';
  surface: ProposalSurface;
  /** Resolved caller/operator customer id, when known. */
  customerId?: string;
  conversationId?: string;
  aiRunId?: string;
  createdBy: string;
  tenantThresholdOverride?: Partial<Record<'supervisor' | 'tech' | 'both', number>>;
}

/** Repos each adapter already has wired; all but `proposalRepo` are best-effort. */
export interface ProtectionProposalDeps {
  proposalRepo: ProposalRepository;
  auditRepo?: AuditRepository;
  customerNegotiationContextProvider?: CustomerNegotiationContextProvider;
  settingsRepo?: SettingsRepository;
  negotiationQuoteResolver?: CurrentQuoteResolver;
}

/**
 * Build + persist the negotiation `callback` (or, when the discount ask
 * genuinely can't be parsed, a `voice_clarification`) and return the
 * stored proposal. Callers push the id onto their own session state.
 */
export async function buildAndPersistNegotiationProposal(
  entities: Record<string, unknown>,
  call: ProtectionProposalCallContext,
  deps: ProtectionProposalDeps,
): Promise<Proposal> {
  const askText = typeof entities.negotiationAsk === 'string' ? entities.negotiationAsk : '';
  const transcript = typeof entities.transcript === 'string' ? entities.transcript : '';
  const detectText = `${askText} ${transcript}`.trim();
  const customerName = typeof entities.customerName === 'string' ? entities.customerName : undefined;
  // Matches both adapters' pre-extraction behavior exactly: the resolved
  // customer id travels on the ENVELOPE (`call.customerId`, sourced from
  // the side effect's top-level `payload.customerId`), not `entities`.
  const negotiationCustomerId = call.customerId;

  // Best-effort LTV/recency enrichment — a read failure never blocks the callback.
  let customerContext: CustomerNegotiationContext | null = null;
  if (negotiationCustomerId && deps.customerNegotiationContextProvider) {
    try {
      customerContext = await deps.customerNegotiationContextProvider.getContext(
        call.tenantId,
        negotiationCustomerId,
      );
    } catch {
      customerContext = null;
    }
  }

  // U6 (P2-036 V2) — additive discount evaluation. Only engages when fully
  // wired AND a customer is resolved; a null result (unconfigured tenant /
  // no quote / error) keeps the V1 (bare callback) behavior identical.
  const evaluation =
    negotiationCustomerId && deps.settingsRepo && deps.negotiationQuoteResolver
      ? await evaluateNegotiationDiscount({
          tenantId: call.tenantId,
          customerId: negotiationCustomerId,
          askText: detectText || askText,
          settingsRepo: deps.settingsRepo,
          quoteResolver: deps.negotiationQuoteResolver,
        })
      : null;

  let proposalType: 'callback' | 'voice_clarification' = 'callback';
  let payload: Record<string, unknown>;
  let summary: string;
  let explanation: string;
  if (evaluation?.decision.kind === 'CLARIFY') {
    // Couldn't parse the target price — ask, never guess.
    proposalType = 'voice_clarification';
    payload = buildDiscountClarificationPayload({
      transcript: detectText || askText,
      ...(call.conversationId ? { conversationId: call.conversationId } : {}),
    });
    summary = 'What price did they ask for?';
    explanation =
      "Heard a discount ask but couldn't make out the price they named. Tap to tell me what to quote — I never guess a discount.";
  } else if (evaluation?.decision.kind === 'ALLOW') {
    // Within policy — a CONFIDENCE-CAPPED one-tap owner action (never auto-applies).
    const allow = buildAllowDiscountCallbackContent({
      decision: evaluation.decision,
      quote: evaluation.quote,
      askText: askText || detectText,
      ...(customerName ? { customerName } : {}),
      ...(call.conversationId ? { conversationId: call.conversationId } : {}),
    });
    payload = allow.payload;
    summary = allow.summary;
    explanation = allow.explanation;
  } else {
    // NEEDS_APPROVAL / REJECT_WITH_COUNTER → enriched callback; null → V1.
    const content = buildNegotiationCallbackContent({
      detectText,
      ...(askText ? { askText } : {}),
      ...(customerName ? { customerName } : {}),
      ...(call.conversationId ? { conversationId: call.conversationId } : {}),
      customerContext,
      ...(evaluation ? { decision: evaluation.decision, quote: evaluation.quote } : {}),
    });
    payload = content.payload;
    summary = content.summary;
    explanation = content.explanation;
  }

  if (evaluation && deps.auditRepo) {
    try {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: call.tenantId,
          actorId: call.createdBy,
          actorRole: 'system',
          eventType: 'negotiation.discount_evaluated',
          entityType: 'voice_session',
          entityId: call.sessionId,
          metadata: discountAuditMetadata(evaluation.decision, evaluation.quote.quotedCents),
        }),
      );
    } catch {
      /* audit is best-effort */
    }
  }

  const proposal = buildProposal({
    tenantId: call.tenantId,
    proposalType,
    payload,
    summary,
    explanation,
    sourceContext: {
      source: 'calling-agent',
      channel: call.channel,
      surface: call.surface,
      sessionId: call.sessionId,
    },
    ...(call.aiRunId ? { aiRunId: call.aiRunId } : {}),
    createdBy: call.createdBy,
    ...(call.tenantThresholdOverride ? { tenantThresholdOverride: call.tenantThresholdOverride } : {}),
  });
  return deps.proposalRepo.create(proposal);
}

/**
 * Build + persist the complaint's paper-trail `callback` proposal and
 * return the stored proposal. `add_note` is not S1-allowed, so — mirroring
 * the telephony path — this always mints `callback` (S1/S2-safe) rather
 * than routing through the generic map, which would otherwise coerce a
 * live complaint into a bare, unexecutable `voice_clarification`.
 */
export async function buildAndPersistComplaintProposal(
  entities: Record<string, unknown>,
  utterance: string | undefined,
  call: ProtectionProposalCallContext,
  deps: ProtectionProposalDeps,
): Promise<Proposal> {
  const description = typeof entities.noteBody === 'string' ? entities.noteBody : '';
  const transcript = typeof entities.transcript === 'string' ? entities.transcript : '';
  const detectText = `${description} ${transcript} ${utterance ?? ''}`.trim();
  const customerName = typeof entities.customerName === 'string' ? entities.customerName : undefined;

  const content = buildComplaintCallbackContent({
    detectText,
    ...(customerName ? { customerName } : {}),
    ...(call.conversationId ? { conversationId: call.conversationId } : {}),
  });
  const proposal = buildProposal({
    tenantId: call.tenantId,
    proposalType: 'callback',
    payload: content.payload,
    summary: content.summary,
    explanation: content.explanation,
    sourceContext: {
      source: 'calling-agent',
      channel: call.channel,
      surface: call.surface,
      sessionId: call.sessionId,
    },
    ...(call.aiRunId ? { aiRunId: call.aiRunId } : {}),
    createdBy: call.createdBy,
    ...(call.tenantThresholdOverride ? { tenantThresholdOverride: call.tenantThresholdOverride } : {}),
  });
  return deps.proposalRepo.create(proposal);
}
