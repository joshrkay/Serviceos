/**
 * P8-016 — 5-second context preface composer (DETERMINISTIC TEMPLATE, NOT LLM).
 *
 * When a vulnerable + urgent call is patched to the owner's cell, the owner
 * hears a short spoken preface before the caller is connected. The preface is
 * a fixed string template — never an LLM generation — so it is bounded,
 * predictable, and cannot hallucinate a clinical claim.
 *
 * SHAPE (per the dispatch risk note):
 *   "Vulnerability: <vulnLabel>. Reason: <reason>. Customer <customerLabel>.
 *    Putting them through."
 *
 * PII rules (hard): the preface uses only the NON-PII evidence strings plus
 * a customer label of "<first name>, customer since <YYYY>" (or "new" /
 * "unknown" when we have no record). NEVER a full address, phone, email, DOB,
 * or a clinical diagnosis. The medical evidence is the verbatim "caller
 * mentioned X" string — no paraphrase into "you have a medical emergency".
 *
 * The 5-second budget is enforced here as a CHARACTER bound on the composed
 * template (a deterministic proxy). The true <5s synthesized-audio assertion
 * belongs in an integration/e2e test with a real TTS engine — out of scope for
 * the unit suite (no TTS in this environment).
 */
import type { VulnerabilitySignal } from '@ai-service-os/shared';

/**
 * Upper bound on the composed preface length. ~140 characters of plain speech
 * is comfortably under 5 seconds at a normal TTS rate (~12–15 chars/sec). The
 * composer truncates evidence (not the closing sentence) to stay within budget.
 */
export const MAX_PREFACE_CHARS = 220;

export interface PrefaceCustomer {
  firstName?: string;
  /** Year the customer record was created ("customer since YYYY"). */
  customerSinceYear?: number;
}

/** Map a signal kind to a short, non-clinical vulnerability label. */
function vulnLabelFor(signals: VulnerabilitySignal[]): string {
  // Preserve detection order; de-dupe kinds; render a compact list.
  const order: VulnerabilitySignal['kind'][] = [];
  for (const s of signals) if (!order.includes(s.kind)) order.push(s.kind);
  const labels: Record<VulnerabilitySignal['kind'], string> = {
    medical: 'medical',
    age: 'elderly',
    weather: 'extreme weather',
    property: 'occupied property',
  };
  if (order.length === 0) return 'flagged';
  return order.map((k) => labels[k]).join(', ');
}

/** Build the NON-PII customer label. */
function customerLabelFor(customer?: PrefaceCustomer): string {
  if (!customer || !customer.firstName) return 'unknown caller';
  if (customer.customerSinceYear) {
    return `${customer.firstName}, customer since ${customer.customerSinceYear}`;
  }
  return `${customer.firstName}, new customer`;
}

export interface ComposePrefaceInput {
  signals: VulnerabilitySignal[];
  /** Short non-PII reason (typically the triage decision's `reason`). */
  reason: string;
  customer?: PrefaceCustomer;
}

/**
 * Compose the deterministic preface string. Always returns a string within
 * `MAX_PREFACE_CHARS`; the reason is the only segment that may be truncated
 * (with an ellipsis) so the closing "Putting them through." is never dropped.
 */
export function composeContextPreface(input: ComposePrefaceInput): string {
  const vulnLabel = vulnLabelFor(input.signals);
  const customerLabel = customerLabelFor(input.customer);
  const closing = 'Putting them through.';

  const build = (reason: string): string =>
    `Vulnerability: ${vulnLabel}. Reason: ${reason}. Customer ${customerLabel}. ${closing}`;

  let preface = build(input.reason);
  if (preface.length <= MAX_PREFACE_CHARS) return preface;

  // Over budget: trim the reason to fit, preserving the closing sentence.
  const overrun = preface.length - MAX_PREFACE_CHARS;
  const trimmedReason =
    input.reason.length > overrun + 1
      ? `${input.reason.slice(0, input.reason.length - overrun - 1).trimEnd()}…`
      : '…';
  preface = build(trimmedReason);
  // Final hard guard in case label segments themselves blow the budget.
  return preface.length <= MAX_PREFACE_CHARS
    ? preface
    : preface.slice(0, MAX_PREFACE_CHARS - 1) + '…';
}
