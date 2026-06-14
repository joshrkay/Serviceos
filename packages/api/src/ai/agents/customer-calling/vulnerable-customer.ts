/**
 * RV-123 — mark-customer-vulnerable + the derived flag accessor.
 *
 * Persistence rides the EXISTING `update_customer` proposal payload — no
 * contract change. The customer model has no dedicated "vulnerable" column;
 * the durable signals are:
 *
 *   - `customers.date_of_birth` (migration 113, model field `dateOfBirth`) —
 *     age ≥ 65 derives the flag, exactly like the P8-016 age detector;
 *   - `customers.account_type` (migration 113, model field `accountType`) —
 *     read-only context, not written here;
 *   - a `[vulnerability]`-marked line in `communication_notes` (model field
 *     `communicationNotes`, written via the update_customer payload's
 *     EXISTING `notes` field) — carries the triage evidence for callers
 *     whose DOB is not on file.
 *
 * The write path is a PROPOSAL (human-approved, per the platform's no-auto-
 * mutation rule): `buildMarkCustomerVulnerablePayload` produces the payload
 * and the triage hook's app wiring queues it.
 *
 * DOCUMENTED LIMITATION (consumers): there is no upsell module in the
 * codebase today (grep 'upsell' → no hooks) and no per-customer prompt-hint
 * injection point on the voice path. `isVulnerableCustomer` +
 * `VULNERABLE_CALLER_PROMPT_HINT` are the exposed seams: when an upsell /
 * pacing surface lands, gate it on the accessor and append the hint to the
 * caller-plan prompt section. Until then this story persists the flag and
 * exposes the accessor — nothing more.
 */
import type { TriageDecision } from '@ai-service-os/shared';

export const VULNERABILITY_NOTE_MARKER = '[vulnerability]';

/** Age at/above which a DOB on file derives the vulnerable flag (P8-016). */
export const VULNERABLE_AGE_YEARS = 65;

/**
 * Prompt-hint seam for future pacing/upsell-suppression wiring. Append to
 * the classifier/persona prompt section for flagged callers.
 */
export const VULNERABLE_CALLER_PROMPT_HINT =
  'This caller is flagged as potentially vulnerable: speak slower, use short ' +
  'plain sentences, confirm understanding, and do NOT offer optional add-ons, ' +
  'memberships, or upsells.';

/** NON-PII note line composed from the triage decision's evidence strings. */
export function composeVulnerabilityNote(
  decision: Pick<TriageDecision, 'reason' | 'score'>,
  now: Date = new Date(),
): string {
  const evidence = decision.score.signals.map((s) => s.evidence).join('; ');
  const day = now.toISOString().slice(0, 10);
  return `${VULNERABILITY_NOTE_MARKER} ${decision.reason}${evidence ? ` — ${evidence}` : ''} (auto-flagged by voice triage ${day})`;
}

/**
 * The EXISTING update_customer payload shape (contracts.ts): `notes` maps to
 * `communicationNotes` in UpdateCustomerExecutionHandler. Existing notes are
 * preserved by prepending; an already-marked note is returned unchanged
 * (null → nothing to update).
 */
export function buildMarkCustomerVulnerablePayload(
  customerId: string,
  decision: Pick<TriageDecision, 'reason' | 'score'>,
  existingNotes?: string,
  now: Date = new Date(),
): { customerId: string; notes: string } | null {
  if (existingNotes?.includes(VULNERABILITY_NOTE_MARKER)) return null;
  const note = composeVulnerabilityNote(decision, now);
  return {
    customerId,
    notes: existingNotes && existingNotes.trim().length > 0
      ? `${note}\n${existingNotes}`
      : note,
  };
}

/**
 * Derived flag accessor — the single seam handlers consult.
 * True when the m113 DOB implies age ≥ 65 OR the communication notes carry
 * the vulnerability marker.
 */
export function isVulnerableCustomer(
  customer: { dateOfBirth?: Date; communicationNotes?: string } | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!customer) return false;
  if (customer.communicationNotes?.includes(VULNERABILITY_NOTE_MARKER)) return true;
  if (customer.dateOfBirth instanceof Date && !isNaN(customer.dateOfBirth.getTime())) {
    const age =
      (now.getTime() - customer.dateOfBirth.getTime()) / (365.25 * 24 * 3600 * 1000);
    if (age >= VULNERABLE_AGE_YEARS) return true;
  }
  return false;
}
