/**
 * P2-036 / N-003 — negotiation guardrail callback payload contract.
 *
 * When a customer pushes on price/scope/terms, the AI never negotiates: it
 * routes a capture-class `callback` proposal to the owner (built by api
 * `proposals/guardrails/negotiation-guardrail.ts`). This contract freezes the
 * SHAPE of that payload so the producer (the guardrail builder) and every
 * consumer (SMS render, voice readback, review UI) agree, and so the payload is
 * Zod-validated like every other proposal — not an untyped bag.
 *
 * All money is integer cents. The payload carries NO committed price or
 * discount: V1 blocks discounts entirely (price-floor handling is a V2
 * non-goal), so the owner decides and follows up on their terms.
 */
import { z } from 'zod';

/**
 * The deterministic ask types the guardrail refines a `negotiation` intent into
 * (the single source of truth — api `NegotiationAskType` imports these).
 */
const NEGOTIATION_ASK_TYPES = [
  'discount',
  'scope_change',
  'refund_leverage',
  'manager_escalation',
  'deadline_threat',
] as const;
export type NegotiationAskType = (typeof NEGOTIATION_ASK_TYPES)[number];

/** Payload-level ask type: the detected types plus a `general` fallback (no pattern matched). */
const NEGOTIATION_PAYLOAD_ASK_TYPES = [...NEGOTIATION_ASK_TYPES, 'general'] as const;

/**
 * Customer history surfaced to the owner so the recommendation can reflect WHO
 * is asking. `lastSeenAt` is an ISO-8601 UTC string (or null for a brand-new
 * caller); `recencyLabel` is the human phrase ("3 weeks ago", "new customer").
 */
export const negotiationCustomerContextSchema = z.object({
  lifetimeValueCents: z.number().int().min(0),
  lastSeenAt: z.string().datetime().nullable(),
  recencyLabel: z.string().min(1),
  jobsCompletedCount: z.number().int().min(0),
});
export type NegotiationCustomerContext = z.infer<typeof negotiationCustomerContextSchema>;

/**
 * Confidence levels mirror api `CONFIDENCE_LEVELS`. Kept as a local literal
 * union because `packages/shared` cannot import from `packages/api`; the values
 * are stable (the 4-tier system is locked by P2-035).
 */
const NEGOTIATION_CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'very_low'] as const;

/** Per-field review marker stamped on the proposal so review surfaces flag it. */
const negotiationMarkerSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
});

const negotiationMetaSchema = z.object({
  overallConfidence: z.enum(NEGOTIATION_CONFIDENCE_LEVELS),
  markers: z.array(negotiationMarkerSchema),
});

/**
 * The `callback` proposal payload for a detected negotiation. Producer:
 * `buildNegotiationCallbackContent`. `reason` is a fixed literal so consumers
 * can discriminate a negotiation callback from other capture-class callbacks.
 */
export const negotiationCallbackPayloadSchema = z.object({
  reason: z.literal('customer_negotiation_followup'),
  negotiationAskType: z.enum(NEGOTIATION_PAYLOAD_ASK_TYPES),
  /** The customer's verbatim ask ("can you knock $50 off?"). */
  askText: z.string(),
  /** Deterministic owner-facing recommendation. Never a discount amount (V1 blocks discounts). */
  recommendation: z.string().min(1),
  /** Customer history; null for an unknown caller. */
  customerContext: negotiationCustomerContextSchema.nullable(),
  /** Full transcript / message body for the owner to read. */
  transcript: z.string().optional(),
  conversationId: z.string().optional(),
  _meta: negotiationMetaSchema,
});
export type NegotiationCallbackPayload = z.infer<typeof negotiationCallbackPayloadSchema>;

/**
 * V2 negotiation (D-013) — the discount evaluator's decision.
 *
 * `evaluateDiscountAsk` (api `proposals/guardrails/discount-evaluator.ts`)
 * classifies a resolved discount ask into one of four outcomes. All money is
 * integer cents; all percentages are basis points. The decision is the single
 * source of truth the handlers branch on (capped ALLOW proposal vs. owner
 * callback vs. voice clarification vs. counter). Even `ALLOW` never
 * auto-executes — it is surfaced as a one-tap, confidence-capped proposal (R5).
 *
 * Outcome + reason constants are UPPERCASE/snake_case to match the D-013
 * decision record verbatim.
 */
const DISCOUNT_DECISION_OUTCOMES = [
  'ALLOW',
  'NEEDS_APPROVAL',
  'CLARIFY',
  'REJECT_WITH_COUNTER',
] as const;
export type DiscountDecisionOutcome = (typeof DISCOUNT_DECISION_OUTCOMES)[number];

/** Why a within-reason ask routes to the owner rather than an auto-proposal. */
const DISCOUNT_APPROVAL_REASONS = [
  /** Tenant has not opted into self-service discounts (maxBps 0 → V1 behavior). */
  'no_policy',
  /** Scope is not catalog-grounded, so no trustworthy floor can be computed. */
  'ungrounded_scope',
] as const;
export type DiscountApprovalReason = (typeof DISCOUNT_APPROVAL_REASONS)[number];

/** Why the ask could not be resolved to a concrete target price. */
const DISCOUNT_CLARIFY_REASONS = [
  /** The spoken/typed target price could not be parsed deterministically. */
  'ambiguous_target',
] as const;
export type DiscountClarifyReason = (typeof DISCOUNT_CLARIFY_REASONS)[number];

const centsField = z.number().int().min(0);

/**
 * Discriminated on `outcome`. The priced branches (`ALLOW`,
 * `REJECT_WITH_COUNTER`) echo `listCents` + `floorCents` so the handler can
 * render/audit the grounding without recomputing it.
 */
export const discountDecisionSchema = z.discriminatedUnion('outcome', [
  // Within policy AND at/above floor: may be PROPOSED (confidence-capped, R5).
  z.object({
    outcome: z.literal('ALLOW'),
    /** Price to propose — guaranteed `>= floorCents`. */
    targetPriceCents: centsField,
    /** `listCents - targetPriceCents`. */
    discountCents: centsField,
    /** Effective discount in basis points (0–10000). */
    discountBps: z.number().int().min(0).max(10000),
    listCents: centsField,
    floorCents: centsField,
  }),
  // Plausible but not auto-proposable: routes to the owner callback.
  z.object({
    outcome: z.literal('NEEDS_APPROVAL'),
    reason: z.enum(DISCOUNT_APPROVAL_REASONS),
    /** Present when a concrete target was parsed; absent when none was. */
    targetPriceCents: centsField.optional(),
    floorCents: centsField.optional(),
  }),
  // Target price is ambiguous: emit a voice_clarification, never guess (R4).
  z.object({
    outcome: z.literal('CLARIFY'),
    reason: z.enum(DISCOUNT_CLARIFY_REASONS),
  }),
  // Below the floor: reject the ask, offer the floor as the counter.
  z.object({
    outcome: z.literal('REJECT_WITH_COUNTER'),
    /** What the customer asked for (strictly `< floorCents`). */
    requestedPriceCents: centsField,
    /** The floor price — the best the AI may offer. */
    counterPriceCents: centsField,
    listCents: centsField,
    floorCents: centsField,
  }),
]);
export type DiscountDecision = z.infer<typeof discountDecisionSchema>;
