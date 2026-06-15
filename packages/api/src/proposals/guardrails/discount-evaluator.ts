/**
 * V2 negotiation (D-013) — pure discount decision evaluator.
 *
 * `evaluateDiscountAsk` maps a resolved discount ask to a {@link DiscountDecision}
 * (ALLOW / NEEDS_APPROVAL / CLARIFY / REJECT_WITH_COUNTER). It is a standalone
 * pure function — no I/O, no mocks needed — so the money core can be tested
 * exhaustively and run identically across all three negotiation surfaces
 * (SMS task handler, inbound-SMS handler, live-call FSM). The handlers do the
 * async work (resolve policy/catalog/member context) and then call this.
 *
 * Invariants:
 *   - All money is integer cents; all percentages basis points (`applyBps`,
 *     the single rounding home — never `* 0.9`).
 *   - The AI never silently discounts: even ALLOW is surfaced as a
 *     confidence-capped, human-tapped proposal by the caller (R5). This
 *     function only decides *whether* an in-policy ask may be proposed.
 *   - Fail-closed: an unconfigured tenant (maxBps 0) reproduces V1 exactly —
 *     every ask routes to the owner callback (NEEDS_APPROVAL / no_policy).
 *   - Ungrounded scope (no trustworthy catalog list price) → NEEDS_APPROVAL;
 *     we never price a discount we can't ground (R3).
 *
 * Floor model (R3, `max(list-minus-cap, absolute floor)`, member-adjusted):
 *   memberAdjustedBase = list − applyBps(list, memberBps)   // what the member already pays
 *   capFloor           = base − applyBps(base, maxBps)      // deepest the % ceiling allows
 *   floor              = neverBelowCatalog
 *                          ? max(capFloor, absoluteFloor ?? 0)   // strict: cap always binds
 *                          : (absoluteFloor ?? capFloor)         // lenient: a set hard floor may bind below the cap
 * The member-adjusted base is the stacking defense: a member's negotiation
 * discount is measured against the price they *already* pay, so member% and
 * negotiation% cannot compound below margin.
 */
import { applyBps } from '../../shared/billing-engine';
import type { DiscountPolicy } from '../../settings/settings';
import type { DiscountDecision } from '@ai-service-os/shared';

/** Catalog grounding for the scope under negotiation. */
export type DiscountGrounding =
  | { catalogGrounded: true; listCents: number }
  | { catalogGrounded: false };

/** Parsed target price (U4 parser output); `ambiguous` → CLARIFY, never a guess. */
export type DiscountTarget =
  | { ambiguous: false; targetPriceCents: number }
  | { ambiguous: true };

export interface DiscountAskInput {
  /** Resolved per-tenant policy (`settings.resolveDiscountPolicy`). */
  policy: DiscountPolicy;
  /** Catalog grounding; `catalogGrounded: false` forces NEEDS_APPROVAL. */
  grounding: DiscountGrounding;
  /** Parsed target price; `ambiguous: true` forces CLARIFY. */
  target: DiscountTarget;
  /**
   * Member discount already in effect for this customer, in bps (default 0).
   * The floor is measured against the member-adjusted base so negotiation and
   * membership discounts can't stack below margin (member-stacking defense).
   */
  memberDiscountBps?: number;
}

/** Express an amount as basis points of a base, clamped to [0, 10000]. */
function amountToBps(amountCents: number, baseCents: number): number {
  if (baseCents <= 0) return 0;
  return Math.min(10000, Math.max(0, Math.round((amountCents * 10000) / baseCents)));
}

export function evaluateDiscountAsk(input: DiscountAskInput): DiscountDecision {
  const { policy, grounding, target } = input;
  const memberBps = clampBps(input.memberDiscountBps ?? 0);

  // 1. Not opted in (maxBps 0) → exact V1 behavior: owner callback, no pricing.
  //    Checked first so an unconfigured tenant never parses/grounds at all.
  if (policy.maxBps <= 0) {
    return { outcome: 'NEEDS_APPROVAL', reason: 'no_policy' };
  }

  // 2. Ungrounded scope → can't compute a trustworthy floor → owner callback.
  if (!grounding.catalogGrounded) {
    return { outcome: 'NEEDS_APPROVAL', reason: 'ungrounded_scope' };
  }

  // 3. Ambiguous target → clarify, never guess a number (R4).
  if (target.ambiguous) {
    return { outcome: 'CLARIFY', reason: 'ambiguous_target' };
  }

  // 4. Price it. All terms measured against the member-adjusted base.
  const listCents = Math.max(0, Math.round(grounding.listCents));
  const memberAdjustedBase = Math.max(0, listCents - applyBps(listCents, memberBps));
  const capFloor = Math.max(0, memberAdjustedBase - applyBps(memberAdjustedBase, policy.maxBps));
  const absoluteFloor = policy.floorCents;

  let floorCents: number;
  if (policy.neverBelowCatalog) {
    // Strict (default): the % cap always binds; a hard floor can only raise it.
    floorCents = Math.max(capFloor, absoluteFloor ?? 0);
  } else {
    // Lenient: a configured hard floor may bind below the % cap; else the cap.
    floorCents = absoluteFloor != null ? Math.max(0, absoluteFloor) : capFloor;
  }
  floorCents = Math.max(0, floorCents);

  const targetPriceCents = Math.max(0, Math.round(target.targetPriceCents));

  if (targetPriceCents >= floorCents) {
    const discountCents = Math.max(0, listCents - targetPriceCents);
    return {
      outcome: 'ALLOW',
      targetPriceCents,
      discountCents,
      discountBps: amountToBps(discountCents, listCents),
      listCents,
      floorCents,
    };
  }

  // Below the floor → reject and counter at the floor (the best AI offer).
  return {
    outcome: 'REJECT_WITH_COUNTER',
    requestedPriceCents: targetPriceCents,
    counterPriceCents: floorCents,
    listCents,
    floorCents,
  };
}

/** Defensive bps clamp (inputs are validated upstream, but the money core never trusts them). */
function clampBps(bps: number): number {
  if (!Number.isFinite(bps) || bps <= 0) return 0;
  return Math.min(10000, Math.round(bps));
}
