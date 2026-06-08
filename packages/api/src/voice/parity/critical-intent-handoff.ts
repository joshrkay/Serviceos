/**
 * Confidence-threshold handoff for critical intents (Feature 2).
 *
 * The Avoca-parity bar is explicit: when the classifier's confidence on a
 * CRITICAL intent (booking, payment, complaint) is below 0.7, the AI must
 * offer a human transfer rather than act on a shaky read. This is distinct
 * from — and stricter than — the existing two-tier gate in the FSM
 * (`CLASSIFIER_CONFIDENCE_THRESHOLD = 0.6`, `TAU_INT = 0.75`), which governs
 * whether to *act* vs *reprompt* on any intent. Here we govern whether to
 * *offer a human* specifically on the high-stakes intents where a wrong
 * autonomous action is most costly (a missed booking, a mishandled payment,
 * an escalating complaint).
 *
 * Pure and side-effect free: the caller (FSM / adapter) decides how to act on
 * the decision. The classifier remains the source of truth for the intent
 * string and confidence; this module only encodes the parity rule.
 */

/**
 * Threshold below which a critical-intent classification is considered too
 * weak to act on autonomously. Matches the Avoca competitive bar exactly.
 */
export const CRITICAL_INTENT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Canonical critical-intent families. We match by family so the rule survives
 * the classifier's concrete intent vocabulary evolving (e.g. `create_invoice`,
 * `record_payment`, and `lookup_balance` all belong to the `payment` family).
 */
export type CriticalIntentFamily = 'booking' | 'payment' | 'complaint';

/**
 * Maps concrete classifier intent strings to a critical family, or `null`
 * when the intent is not in the critical set. Kept as data so it is trivially
 * auditable and unit-testable; unknown intents fall through to `null`.
 */
const INTENT_TO_CRITICAL_FAMILY: Readonly<Record<string, CriticalIntentFamily>> = {
  // Booking — committing the customer to a calendar slot.
  book_appointment: 'booking',
  create_appointment: 'booking',
  reschedule_appointment: 'booking',
  cancel_appointment: 'booking',
  confirm_appointment: 'booking',
  // Payment / money movement — wrong action here touches funds.
  record_payment: 'payment',
  create_invoice: 'payment',
  issue_invoice: 'payment',
  send_invoice: 'payment',
  billing_question: 'payment',
  lookup_balance: 'payment',
  lookup_invoices: 'payment',
  // Complaint — a dissatisfied caller is a retention/safety risk; never
  // autonomously "handle" a low-confidence complaint.
  complaint: 'complaint',
};

/** Returns the critical family for an intent, or `null` if it is not critical. */
export function criticalFamilyOf(intent: string): CriticalIntentFamily | null {
  return INTENT_TO_CRITICAL_FAMILY[intent] ?? null;
}

/** True when the intent belongs to a critical family. */
export function isCriticalIntent(intent: string): boolean {
  return criticalFamilyOf(intent) !== null;
}

export interface CriticalHandoffInput {
  /** Free-form intent string from the classifier. */
  intent: string;
  /** Classifier confidence in [0, 1]. */
  confidence: number;
}

export interface CriticalHandoffDecision {
  /** Whether the AI should proactively offer a human transfer. */
  offerHumanTransfer: boolean;
  /** The critical family that triggered the rule, if any (for telemetry/UX). */
  family: CriticalIntentFamily | null;
  /** Human-readable reason, suitable for an audit trail. */
  reason: 'critical_intent_low_confidence' | 'not_applicable';
}

/**
 * Decide whether to offer a human transfer for a (possibly critical) intent.
 *
 * Rule: offer transfer iff the intent is in the critical set AND confidence is
 * strictly below {@link CRITICAL_INTENT_CONFIDENCE_THRESHOLD}. Confidence is
 * clamped defensively — a NaN or out-of-range score is treated as 0 (lowest
 * trust), so a malformed classifier response fails safe toward a human.
 */
export function decideCriticalHandoff(input: CriticalHandoffInput): CriticalHandoffDecision {
  const family = criticalFamilyOf(input.intent);
  if (family === null) {
    return { offerHumanTransfer: false, family: null, reason: 'not_applicable' };
  }
  const confidence = clampConfidence(input.confidence);
  if (confidence < CRITICAL_INTENT_CONFIDENCE_THRESHOLD) {
    return { offerHumanTransfer: true, family, reason: 'critical_intent_low_confidence' };
  }
  return { offerHumanTransfer: false, family, reason: 'not_applicable' };
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
