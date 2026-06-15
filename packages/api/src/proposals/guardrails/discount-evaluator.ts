/**
 * U3 (P2-036 V2) — Pure discount-decision evaluator: the MONEY-CORRECTNESS CORE.
 *
 * When a customer pushes on price, U4 (target-price-parser.ts) extracts the
 * concrete number they named and the negotiation guardrail classifies the ask.
 * This module is the deterministic judge that sits between those parses and any
 * customer-facing reply: given the currently quoted price, the parsed ask, and
 * the resolved per-tenant `DiscountPolicy`, it returns exactly one
 * `DiscountDecision` (ALLOW | NEEDS_APPROVAL | CLARIFY | REJECT_WITH_COUNTER).
 *
 * THE MODEL
 *   - All money is integer cents; all rates are basis points (bps, 0–10000 =
 *     0%–100%). The single percentage-of-money helper is `applyBps` from the
 *     shared billing engine — we never hand-roll `* 0.9`, so the rounding
 *     convention can never drift between this engine and tax/deposit math.
 *   - `currentQuotedCents` is the price the customer currently sees, with any
 *     member discount ALREADY applied. `memberDiscountBps` records that baked-in
 *     discount purely for auditability and a combined-discount sanity guard; it
 *     is NOT re-subtracted here (that would double-count).
 *
 * THE STRICTER-OF-BOTH FLOOR
 *   Two independent floors bound any discount, and we always take the STRICTER
 *   (higher) one:
 *     1. policyAllowsCents — the lowest price still inside the tenant's
 *        auto-allow cap (`maxDiscountBps`). Above this, a human must sign off.
 *     2. effectiveFloorCents (the HARD floor) — the absolute price below which
 *        we never sell, regardless of policy: the max of the tenant's absolute
 *        floor and (when `neverBelowCatalog`) the catalog/margin floor. An ask
 *        under the hard floor is countered AT the floor, never allowed and never
 *        merely escalated.
 *
 * FAIL-CLOSED EQUIVALENCE TO V1
 *   The policy resolver defaults `maxDiscountBps` to 0 for any unconfigured
 *   tenant. With 0, `policyAllowsCents === currentQuotedCents`, so any real
 *   discount fails the ALLOW branch's `requestedFinalCents >= policyAllowsCents`
 *   test and routes to NEEDS_APPROVAL — identical to V1, which blocked
 *   discounts entirely. Opting a tenant into auto-allow is purely additive.
 *
 * ALLOW IS NOT AUTO-EXECUTE
 *   An ALLOW decision means "within policy and at/above the floor"; it is later
 *   confidence-capped by the caller and still flows through the proposal/audit
 *   gate. This engine never executes anything — per CLAUDE.md, no proposal is
 *   ever auto-executed.
 *
 * PURITY
 *   No I/O, no async, no LLM, no clock, no randomness — a pure function of its
 *   input, exhaustively unit-testable (see discount-evaluator.test.ts).
 */
import { applyBps } from '../../shared/billing-engine';
import type { DiscountDecision } from '@ai-service-os/shared';
import type { DiscountPolicy } from '../../settings/settings';
import type { ParsedDiscountTarget } from '../../conversations/negotiation/target-price-parser';

const FULL_BPS = 10_000;

export interface EvaluateDiscountAskInput {
  /** Price the customer currently sees (member pricing already applied); must be > 0. */
  currentQuotedCents: number;
  /** The parsed ask from the U4 target-price parser. */
  parsed: ParsedDiscountTarget;
  /** Resolved per-tenant policy (fail-closed default: `maxDiscountBps` 0). */
  policy: DiscountPolicy;
  /** Did the quoted scope resolve to catalog items? (caller computes). */
  catalogGrounded: boolean;
  /** Discount already baked into `currentQuotedCents` (default 0); audit + sanity guard. */
  memberDiscountBps?: number;
  /** Optional margin/catalog floor (deferred today; usually null). */
  catalogFloorCents?: number | null;
}

/**
 * Best-effort extraction of the parsed ask into the shape NEEDS_APPROVAL
 * carries, used ONLY on the ungrounded path (step 3) where we can't trust the
 * floor enough to do the full evaluation but still want to hand the owner what
 * the customer literally asked for. Returns nulls when a field isn't derivable
 * from the ask alone. The bps figure is clamped to the schema's 0–10000 range.
 */
function bestEffortAsk(
  parsed: ParsedDiscountTarget,
  currentQuotedCents: number,
): { requestedTargetCents: number | null; requestedDiscountBps: number | null } {
  switch (parsed.kind) {
    case 'target_price':
      return { requestedTargetCents: parsed.requestedTargetCents, requestedDiscountBps: null };
    case 'discount_amount':
      return {
        requestedTargetCents: currentQuotedCents - parsed.requestedDiscountAmountCents,
        requestedDiscountBps: null,
      };
    case 'discount_percent': {
      const requestedTargetCents =
        currentQuotedCents - applyBps(currentQuotedCents, parsed.requestedDiscountBps);
      return {
        requestedTargetCents,
        // Parser already bounds this 0–10000; clamp defensively for the schema.
        requestedDiscountBps: Math.max(0, Math.min(FULL_BPS, parsed.requestedDiscountBps)),
      };
    }
    case 'ambiguous':
      return { requestedTargetCents: null, requestedDiscountBps: null };
  }
}

/**
 * Evaluate a single discount ask against tenant policy and the (stricter-of-
 * both) floor. Returns exactly one `DiscountDecision`. See the file header for
 * the model; the branch order below IS the contract and is pinned by the tests.
 */
export function evaluateDiscountAsk(input: EvaluateDiscountAskInput): DiscountDecision {
  const { currentQuotedCents, parsed, policy, catalogGrounded } = input;
  const memberDiscountBps = input.memberDiscountBps ?? 0;
  const catalogFloorCents = input.catalogFloorCents ?? null;

  // 1. Ambiguous parse — caller routes a one-tap voice_clarification.
  if (parsed.kind === 'ambiguous') {
    return { kind: 'CLARIFY', reason: 'ambiguous_discount_target' };
  }

  // 2. No positive base to evaluate against.
  if (currentQuotedCents <= 0) {
    return { kind: 'CLARIFY', reason: 'ambiguous_discount_target' };
  }

  // 3. Ungrounded quote — the floor can't be trusted, so escalate with a
  //    best-effort echo of the literal ask rather than auto-allowing.
  if (!catalogGrounded) {
    const ask = bestEffortAsk(parsed, currentQuotedCents);
    return {
      kind: 'NEEDS_APPROVAL',
      requestedTargetCents: ask.requestedTargetCents,
      requestedDiscountBps: ask.requestedDiscountBps,
    };
  }

  // 4. Normalize the ask to the final price the customer wants (integer cents).
  let requestedFinalCents: number;
  switch (parsed.kind) {
    case 'target_price':
      requestedFinalCents = parsed.requestedTargetCents;
      break;
    case 'discount_amount':
      requestedFinalCents = currentQuotedCents - parsed.requestedDiscountAmountCents;
      break;
    case 'discount_percent':
      requestedFinalCents =
        currentQuotedCents - applyBps(currentQuotedCents, parsed.requestedDiscountBps);
      break;
  }

  // 5. Not actually a discount, or nonsensical — clarify.
  if (requestedFinalCents >= currentQuotedCents || requestedFinalCents <= 0) {
    return { kind: 'CLARIFY', reason: 'ambiguous_discount_target' };
  }

  // 6. Effective discount the ask represents, in bps (integer).
  const requestedDiscountBps = Math.round(
    ((currentQuotedCents - requestedFinalCents) * FULL_BPS) / currentQuotedCents,
  );

  // 7. Combined-discount sanity: a member discount stacked with this ask can't
  //    approach ~100% off. Counter at the floor.
  const effectiveFloorCentsForReject = Math.max(
    policy.absoluteFloorCents ?? 0,
    policy.neverBelowCatalog ? catalogFloorCents ?? 0 : 0,
    0,
  );
  if (memberDiscountBps + requestedDiscountBps >= FULL_BPS) {
    return {
      kind: 'REJECT_WITH_COUNTER',
      counterCents: effectiveFloorCentsForReject,
      floorCents: effectiveFloorCentsForReject,
    };
  }

  // 8. Floors (all integer, non-negative).
  //    policyAllowsCents — lowest price within the auto-allow cap.
  const policyAllowsCents = applyBps(currentQuotedCents, FULL_BPS - policy.maxDiscountBps);
  //    hardFloorCents — never sell below this, regardless of policy (stricter of
  //    the absolute floor and, when neverBelowCatalog, the catalog floor).
  const hardFloorCents = Math.max(
    policy.absoluteFloorCents ?? 0,
    policy.neverBelowCatalog ? catalogFloorCents ?? 0 : 0,
    0,
  );
  const effectiveFloorCents = Math.max(hardFloorCents, 0);

  // 9. Branch (order is the contract).
  if (requestedFinalCents < effectiveFloorCents) {
    return {
      kind: 'REJECT_WITH_COUNTER',
      counterCents: effectiveFloorCents,
      floorCents: effectiveFloorCents,
    };
  }

  if (
    requestedDiscountBps <= policy.maxDiscountBps &&
    requestedFinalCents >= policyAllowsCents &&
    requestedFinalCents >= effectiveFloorCents
  ) {
    return {
      kind: 'ALLOW',
      approvedDiscountBps: requestedDiscountBps,
      discountedPriceCents: requestedFinalCents,
      floorCents: effectiveFloorCents,
    };
  }

  return {
    kind: 'NEEDS_APPROVAL',
    requestedTargetCents: requestedFinalCents,
    requestedDiscountBps,
  };
}
