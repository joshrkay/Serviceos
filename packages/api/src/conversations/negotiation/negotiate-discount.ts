/**
 * V2 negotiation (D-013) — discount orchestration.
 *
 * Composes the deterministic parser (U4) and the pure evaluator (U3) into the
 * single decision the negotiation surfaces branch on. Pure (no I/O): the
 * handlers do the async work — resolve the tenant policy, ground the scope
 * against the catalog (listCents), read the customer's member discount — then
 * call this so the SMS task handler, the inbound-SMS handler, and the live-call
 * FSM all reach a byte-identical decision (the plan's "run identically across
 * three surfaces" requirement).
 */
import { parseDiscountAsk, resolveTargetFromParsedAsk } from './discount-ask-parser';
import {
  evaluateDiscountAsk,
  type DiscountGrounding,
} from '../../proposals/guardrails/discount-evaluator';
import type { DiscountPolicy } from '../../settings/settings';
import type { DiscountDecision } from '@ai-service-os/shared';

export interface NegotiationDiscountInput {
  /** Resolved per-tenant policy (`settings.resolveDiscountPolicy`). */
  policy: DiscountPolicy;
  /** The customer's verbatim ask ("can you knock $50 off?"). */
  askText: string;
  /** Catalog grounding for the scope under negotiation. */
  grounding: DiscountGrounding;
  /** Member discount already in effect for this customer, in bps (default 0). */
  memberDiscountBps?: number;
}

/**
 * Decide a discount ask end-to-end. Parses the target from the ask text, grounds
 * it against the catalog list price (only when the scope is catalog-grounded —
 * otherwise the evaluator returns NEEDS_APPROVAL on `ungrounded_scope` before
 * the target is ever read, so an ambiguous placeholder is safe), then evaluates.
 */
export function evaluateNegotiationDiscount(input: NegotiationDiscountInput): DiscountDecision {
  const parsed = parseDiscountAsk(input.askText);
  const target = input.grounding.catalogGrounded
    ? resolveTargetFromParsedAsk(parsed, input.grounding.listCents)
    : { ambiguous: true as const };
  return evaluateDiscountAsk({
    policy: input.policy,
    grounding: input.grounding,
    target,
    ...(input.memberDiscountBps != null ? { memberDiscountBps: input.memberDiscountBps } : {}),
  });
}
