/**
 * N-004 (P2-037) — the four Supervisor Agent checks (pure logic).
 *
 * Deterministic checks (pricing-anomaly, account-routing, banned-phrase half
 * of brand-voice, and the urgency severity pre-filter) live here as pure
 * functions so they are unit-tested without a gateway or DB. The
 * missed-urgency and register-drift LLM signals are parsed here too
 * (`parseSupervisorLlmResponse`) but the model call itself lives in the
 * reviewer.
 */
import { formatUsdCentsFixed } from '@ai-service-os/shared';
import type { CheckResult } from './types';

// ─── Pricing anomaly (deterministic, flag-only) ──────────────────────────────

/** Flag when |total − avg| / avg exceeds this fraction (PRD: >20%). */
export const PRICING_ANOMALY_THRESHOLD = 0.2;
/** Cold-start guard: below this many baseline samples, never flag (new tenants). */
export const PRICING_MIN_SAMPLES = 5;

export interface PricingAnomalyInput {
  /** Proposal headline total via payloadHeadlineCents, or null. */
  totalCents: number | null;
  /** Rolling average for the resolved category / tenant, or null when unknown. */
  baselineAvgCents: number | null;
  /** Number of baseline samples the average was computed from. */
  sampleSize: number;
}

/**
 * Pricing anomaly is ALWAYS flag-only (owner-decided default: pricing +
 * brand-voice never hold). A zero/near-zero total on a money-class proposal
 * is still only a flag here — the hold scope is urgency/routing.
 */
export function checkPricingAnomaly(input: PricingAnomalyInput): CheckResult {
  const { totalCents, baselineAvgCents, sampleSize } = input;
  if (totalCents === null || baselineAvgCents === null || baselineAvgCents <= 0) {
    return {
      id: 'pricing_anomaly',
      verdict: 'pass',
      evidence: { insufficientData: true, totalCents, baselineAvgCents, sampleSize },
    };
  }
  if (sampleSize < PRICING_MIN_SAMPLES) {
    return {
      id: 'pricing_anomaly',
      verdict: 'pass',
      evidence: { insufficientHistory: true, sampleSize },
    };
  }
  const deviation = Math.abs(totalCents - baselineAvgCents) / baselineAvgCents;
  if (deviation > PRICING_ANOMALY_THRESHOLD) {
    const pct = Math.round(deviation * 100);
    const dir = totalCents > baselineAvgCents ? 'above' : 'below';
    return {
      id: 'pricing_anomaly',
      verdict: 'flag',
      reason: `total ${formatUsdCentsFixed(totalCents)} is ${pct}% ${dir} the ${formatUsdCentsFixed(
        baselineAvgCents,
      )} average for similar jobs`,
      evidence: { totalCents, baselineAvgCents, deviation, sampleSize },
    };
  }
  return {
    id: 'pricing_anomaly',
    verdict: 'pass',
    evidence: { deviation, sampleSize },
  };
}

// ─── Account-routing residential↔B2B (deterministic) ─────────────────────────

export type AccountType = 'residential' | 'b2b' | 'property_manager';

export interface AccountRoutingInput {
  /** customers.account_type for the proposal's customer, or null when unknown. */
  accountType: AccountType | null;
  /**
   * True when the proposal payload carries B2B money terms — NET-30 / PO /
   * tax-exempt. Derived by {@link extractRoutingSignals}.
   */
  hasB2bMoneyTerms: boolean;
  /** Segment the routing/template implies, when detectable ('residential'|'b2b'). */
  impliedSegment?: 'residential' | 'b2b' | null;
}

/**
 * Deterministic signal extraction from the payload for account-routing.
 * B2B money terms = NET terms, a PO number, or an explicit tax-exempt flag.
 */
export function extractRoutingSignals(
  payload: Record<string, unknown>,
): { hasB2bMoneyTerms: boolean; impliedSegment: 'residential' | 'b2b' | null } {
  const netTerms = payload.netTerms ?? payload.paymentTerms ?? payload.terms;
  const netTermsHit =
    (typeof netTerms === 'string' && /net[\s-]?\d/i.test(netTerms)) ||
    (typeof netTerms === 'number' && netTerms > 0);
  const poHit =
    typeof payload.poNumber === 'string' && payload.poNumber.trim().length > 0
      ? true
      : typeof payload.purchaseOrder === 'string' && payload.purchaseOrder.trim().length > 0;
  const taxExemptHit = payload.taxExempt === true;
  const hasB2bMoneyTerms = Boolean(netTermsHit || poHit || taxExemptHit);
  const seg = payload.segment ?? payload.customerSegment;
  const impliedSegment =
    seg === 'residential' || seg === 'b2b' ? (seg as 'residential' | 'b2b') : null;
  return { hasB2bMoneyTerms, impliedSegment };
}

/**
 * Account-routing mismatch. `critical` (customer-harm — can hold in enforce)
 * only when the mismatch CHANGES MONEY TERMS: B2B terms (NET / PO / tax-exempt)
 * applied to a residential account. A residential-only flow implied on a
 * B2B / property-manager account is a flag.
 */
export function checkAccountRouting(input: AccountRoutingInput): CheckResult {
  const { accountType, hasB2bMoneyTerms, impliedSegment } = input;
  if (accountType === null) {
    return { id: 'account_routing', verdict: 'pass', evidence: { unknownAccountType: true } };
  }

  // Money-term mismatch: B2B terms on a residential caller. Critical.
  if (accountType === 'residential' && hasB2bMoneyTerms) {
    return {
      id: 'account_routing',
      verdict: 'critical',
      reason: 'B2B money terms (NET / PO / tax-exempt) applied to a residential account',
      evidence: { accountType, hasB2bMoneyTerms },
    };
  }

  // Segment mismatch without money-term change: residential flow on a B2B /
  // property-manager account. Flag.
  if (
    (accountType === 'b2b' || accountType === 'property_manager') &&
    impliedSegment === 'residential'
  ) {
    return {
      id: 'account_routing',
      verdict: 'flag',
      reason: `residential routing on a ${accountType} account`,
      evidence: { accountType, impliedSegment },
    };
  }

  return { id: 'account_routing', verdict: 'pass', evidence: { accountType } };
}

// ─── Brand-voice drift — banned phrases (deterministic, flag-only) ────────────

export interface BrandVoiceInput {
  /** Customer-facing text of the proposal (summary / rendered SMS body). */
  text: string;
  /** Tenant's locked banned-phrase list. */
  bannedPhrases: string[];
  /** LLM register-drift signal (folded in from the supervisor_review call). */
  registerDrift?: boolean;
}

/**
 * Brand-voice drift is ALWAYS flag-only (tone is not customer-harm-critical).
 * A banned-phrase hit is deterministic; register drift comes from the LLM.
 */
export function checkBrandVoice(input: BrandVoiceInput): CheckResult {
  const text = (input.text ?? '').toLowerCase();
  const hits = input.bannedPhrases.filter(
    (p) => p.trim().length > 0 && text.includes(p.toLowerCase()),
  );
  if (hits.length > 0) {
    return {
      id: 'brand_voice_drift',
      verdict: 'flag',
      reason: `banned phrase${hits.length === 1 ? '' : 's'}: ${hits.join(', ')}`,
      evidence: { bannedPhraseHits: hits },
    };
  }
  if (input.registerDrift) {
    return {
      id: 'brand_voice_drift',
      verdict: 'flag',
      reason: 'unusual register vs the tenant locked brand voice',
      evidence: { registerDrift: true },
    };
  }
  return { id: 'brand_voice_drift', verdict: 'pass' };
}

// ─── Missed urgency — deterministic severity pre-filter + LLM ─────────────────

/** Urgency tiers that trigger the deterministic pre-filter. */
const URGENT_SEVERITIES = new Set(['emergency', 'urgent']);
/** Default "same-day" horizon: a scheduled start beyond this is a concern. */
export const DEFAULT_SAME_DAY_HOURS = 24;

export interface UrgencyPreFilterInput {
  /** _meta.severity on the urgency scale (voice triage / MMS vision). */
  severity?: string;
  /** Scheduled appointment start, ISO string, when the proposal books one. */
  scheduledStart?: string;
  now: Date;
  sameDayThresholdHours?: number;
}

/**
 * Deterministic backstop for the LLM: an emergency/urgent triage whose booking
 * is scheduled beyond the same-day horizon is a flag before any model runs.
 * Returns null when there is no deterministic concern.
 */
export function urgencySeverityPreFilter(input: UrgencyPreFilterInput): CheckResult | null {
  if (!input.severity || !URGENT_SEVERITIES.has(input.severity)) return null;
  if (!input.scheduledStart) {
    // Urgent triage with no scheduled time at all is worth a flag.
    return {
      id: 'missed_urgency',
      verdict: 'flag',
      reason: `${input.severity} triage with no scheduled appointment`,
      evidence: { severity: input.severity, scheduledStart: null },
    };
  }
  const start = new Date(input.scheduledStart);
  if (Number.isNaN(start.getTime())) return null;
  const horizonMs = (input.sameDayThresholdHours ?? DEFAULT_SAME_DAY_HOURS) * 60 * 60 * 1000;
  if (start.getTime() - input.now.getTime() > horizonMs) {
    return {
      id: 'missed_urgency',
      verdict: 'flag',
      reason: `${input.severity} triage scheduled beyond same-day`,
      evidence: { severity: input.severity, scheduledStart: input.scheduledStart },
    };
  }
  return null;
}

export interface SupervisorLlmSignals {
  missedUrgency: boolean;
  medicalMentionUnescalated: boolean;
  registerDrift: boolean;
  rationale?: string;
}

/** Parse + bound the supervisor_review model output; null on any shape violation. */
export function parseSupervisorLlmResponse(content: string): SupervisorLlmSignals | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  const bool = (v: unknown): boolean => v === true;
  const rationale = typeof p.rationale === 'string' ? p.rationale.trim().slice(0, 500) : undefined;
  return {
    missedUrgency: bool(p.missedUrgency),
    medicalMentionUnescalated: bool(p.medicalMentionUnescalated),
    registerDrift: bool(p.registerDrift),
    ...(rationale ? { rationale } : {}),
  };
}

/**
 * Combine the deterministic pre-filter with the LLM urgency signals.
 * `critical` (customer-harm, can hold in enforce) when an unescalated medical
 * mention is present — the PRD's flat-voice-elder case, conservatively ANY
 * mention (owner-decided default). Otherwise a flag when either the pre-filter
 * fired or the LLM flagged missed urgency.
 */
export function checkMissedUrgency(
  llm: SupervisorLlmSignals | null,
  preFilter: CheckResult | null,
): CheckResult {
  if (llm?.medicalMentionUnescalated) {
    return {
      id: 'missed_urgency',
      verdict: 'critical',
      reason: 'unescalated medical mention on an urgency-bearing proposal',
      evidence: {
        medicalMentionUnescalated: true,
        ...(llm.rationale ? { rationale: llm.rationale } : {}),
        ...(preFilter ? { preFilter: preFilter.evidence } : {}),
      },
    };
  }
  if (llm?.missedUrgency || preFilter) {
    const reason = llm?.missedUrgency
      ? 'possible missed urgency vs scheduled response'
      : (preFilter?.reason ?? 'urgency concern');
    return {
      id: 'missed_urgency',
      verdict: 'flag',
      reason,
      evidence: {
        ...(llm?.missedUrgency ? { llmMissedUrgency: true } : {}),
        ...(llm?.rationale ? { rationale: llm.rationale } : {}),
        ...(preFilter ? { preFilter: preFilter.evidence } : {}),
      },
    };
  }
  return { id: 'missed_urgency', verdict: 'pass' };
}
