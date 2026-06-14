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
export const NEGOTIATION_ASK_TYPES = [
  'discount',
  'scope_change',
  'refund_leverage',
  'manager_escalation',
  'deadline_threat',
] as const;
export type NegotiationAskType = (typeof NEGOTIATION_ASK_TYPES)[number];

/** Payload-level ask type: the detected types plus a `general` fallback (no pattern matched). */
export const NEGOTIATION_PAYLOAD_ASK_TYPES = [...NEGOTIATION_ASK_TYPES, 'general'] as const;
export type NegotiationPayloadAskType = (typeof NEGOTIATION_PAYLOAD_ASK_TYPES)[number];

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
export const NEGOTIATION_CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'very_low'] as const;

/** Per-field review marker stamped on the proposal so review surfaces flag it. */
export const negotiationMarkerSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
});

export const negotiationMetaSchema = z.object({
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
