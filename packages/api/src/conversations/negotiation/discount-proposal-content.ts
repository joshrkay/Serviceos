/**
 * U5b (P2-036 V2) — shared proposal CONTENT builders for the two additive
 * negotiation-discount branches that aren't the V1 owner callback:
 *
 *   - ALLOW           → a capture-class `callback` whose recommendation states
 *     the concrete approved discount. CRITICAL: it is CONFIDENCE-CAPPED
 *     (`_meta.overallConfidence === 'low'`) so it can NEVER auto-approve
 *     (RV-007 hard-block in `decideInitialStatus`) — it lands in 'draft' as a
 *     one-tap owner action. No auto-apply executor exists; the owner confirms
 *     to send. The payload carries the figures (estimateId / approvedDiscountBps
 *     / discountedPriceCents) so the owner sees exactly what they're approving,
 *     but NOTHING is applied until they tap.
 *   - CLARIFY         → a `voice_clarification` payload (reason
 *     'ambiguous_discount_target') — the ask was understood as a discount but
 *     the number couldn't be parsed, so we ask rather than silently guess.
 *
 * Both surfaces (voice-action-router task + inbound-SMS) compose these so the
 * payload/summary/recommendation are byte-identical across channels. Money is
 * integer cents; discount rates are basis points. Money strings go through the
 * shared `formatUsdCents`.
 */
import { formatUsdCents } from '@ai-service-os/shared';
import type { DiscountDecision } from '@ai-service-os/shared';
import type { CurrentQuote } from './current-quote-resolver';

/** The ALLOW-branch `callback` proposal content (confidence-capped). */
export interface AllowDiscountCallbackContent {
  payload: Record<string, unknown>;
  summary: string;
  explanation: string;
}

/**
 * Build the confidence-capped owner `callback` for an in-policy discount.
 * `decision.kind` must be 'ALLOW' (the caller has already branched).
 */
export function buildAllowDiscountCallbackContent(args: {
  decision: Extract<DiscountDecision, { kind: 'ALLOW' }>;
  quote: CurrentQuote;
  askText: string;
  customerName?: string;
  transcript?: string;
  conversationId?: string;
  /** SMS surface stamps the caller's phone so the owner can call back. */
  callerPhone?: string;
}): AllowDiscountCallbackContent {
  const { decision, quote } = args;
  const who = args.customerName ?? 'the customer';
  const off = quote.quotedCents - decision.discountedPriceCents;
  const pct = (decision.approvedDiscountBps / 100).toFixed(
    Number.isInteger(decision.approvedDiscountBps / 100) ? 0 : 2,
  );
  const recommendation =
    `Within your policy: apply ${formatUsdCents(off)} off (${pct}%) on estimate ${quote.estimateId} → ` +
    `${formatUsdCents(decision.discountedPriceCents)}; confirm to send. ` +
    `Nothing is applied until you tap approve.`;

  const payload: Record<string, unknown> = {
    reason: 'customer_negotiation_followup',
    negotiationAskType: 'discount',
    askText: args.askText.trim(),
    recommendation,
    // Concrete, owner-visible figures for the one-tap action. These are a
    // RECOMMENDATION the owner approves — no executor auto-applies them.
    estimateId: quote.estimateId,
    approvedDiscountBps: decision.approvedDiscountBps,
    discountedPriceCents: decision.discountedPriceCents,
    floorCents: decision.floorCents,
    quotedCents: quote.quotedCents,
    customerContext: null,
    ...(args.transcript ? { transcript: args.transcript } : {}),
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    ...(args.callerPhone ? { callerPhone: args.callerPhone } : {}),
    _meta: {
      // CONFIDENCE CAP: 'low' hard-blocks auto-approval (RV-007). This is the
      // mechanism that keeps an ALLOW from ever auto-applying a discount — it
      // is a one-tap owner action, never a machine mutation.
      overallConfidence: 'low',
      markers: [{ path: 'recommendation', reason: 'negotiation_discount_within_policy' }],
    },
  };

  return {
    payload,
    summary: `Discount within policy from ${who} — confirm to apply ${formatUsdCents(off)} off`,
    explanation:
      'The customer asked for a discount that falls inside your auto-approve policy and stays at/above your floor. ' +
      'This is a one-tap owner action — review and approve to apply it. Nothing is applied automatically.',
  };
}

/**
 * Build the `voice_clarification` payload for an unparseable discount ask.
 * `transcript` is the customer's words; the reason is the schema-allowed
 * 'ambiguous_discount_target'.
 */
export function buildDiscountClarificationPayload(args: {
  transcript: string;
  conversationId?: string;
  recordingId?: string;
}): Record<string, unknown> {
  return {
    transcript: args.transcript.trim(),
    reason: 'ambiguous_discount_target',
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    ...(args.recordingId ? { recordingId: args.recordingId } : {}),
  };
}

/** Owner-facing one-line clarification question for the discount-target ask. */
export const DISCOUNT_CLARIFICATION_QUESTION = 'What price did they ask for?';

/**
 * Flatten a discount decision into auditable figures (requested / floor /
 * quoted), shared by both negotiation surfaces so the `negotiation.discount_
 * evaluated` audit shape is identical across voice and SMS.
 */
export function discountAuditMetadata(
  decision: DiscountDecision,
  quotedCents: number,
): Record<string, unknown> {
  const base: Record<string, unknown> = { decisionKind: decision.kind, quotedCents };
  switch (decision.kind) {
    case 'ALLOW':
      return {
        ...base,
        approvedDiscountBps: decision.approvedDiscountBps,
        discountedPriceCents: decision.discountedPriceCents,
        floorCents: decision.floorCents,
      };
    case 'NEEDS_APPROVAL':
      return {
        ...base,
        requestedTargetCents: decision.requestedTargetCents,
        requestedDiscountBps: decision.requestedDiscountBps,
      };
    case 'REJECT_WITH_COUNTER':
      return { ...base, counterCents: decision.counterCents, floorCents: decision.floorCents };
    case 'CLARIFY':
      return { ...base, reason: decision.reason };
  }
}
