/**
 * VQ-020 — Floor grader (rubric criteria 1-8).
 *
 * `gradeFloor` runs all eight hard-floor checks against an `Observation`
 * and the originating `VoiceQualityScript`. A call passes the floor only
 * when every criterion holds; one strike fails the floor and the call's
 * disposition checks (criteria 9-12) are skipped by the runner.
 *
 * Each check is a pure function exported alongside the aggregator so
 * unit tests can exercise them in isolation. Conservative-stub notes
 * inline where richer observation data would be needed for full fidelity.
 */
import type { Observation } from '../observation';
import type { VoiceQualityScript } from '../schema';
import type { VoiceSessionEvent } from '../../agents/customer-calling/voice-session-store';
import { eventLogIndex } from './event-order';

export interface FloorResult {
  passed: boolean;
  /** Criterion ids 1..8 that failed. Sorted ascending for stable output. */
  failedCriteria: number[];
  /** Map criterion id -> human-readable reason. Only populated for failures. */
  reasons: Record<number, string>;
}

interface CheckResult {
  passed: boolean;
  reason?: string;
}

/**
 * Default per-session cost ceiling used when the script doesn't provide
 * one. Mirrors the spec §5.1 budget envelope.
 */
const DEFAULT_COST_CAP_CENTS = 80;

/** Hard latency cap from spec §3.1 floor #3. */
const HARD_LATENCY_CAP_MS = 7000;

/** Phone number regex covering E.164 and 10-digit forms with separators. */
const PHONE_REGEX = /(\+?1?[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

/** Email regex (deliberately loose — any `local@domain` form). */
const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Balance regex: $XX or $XX.XX. */
const BALANCE_REGEX = /\$\s?\d+(?:\.\d{2})?/;

/**
 * Lookup-skill names that, when executed successfully, mark the caller as
 * identity-resolved. Anything earlier in the event stream is "pre-identity"
 * and PII must not be spoken yet.
 *
 * Production emit sites (`twilio-adapter.ts`, `text-mode-driver.ts`) stamp
 * `lookup_executed.skillName` with the canonical intent type from
 * `intent-classifier.ts`, which uses underscore form
 * (`lookup_customer`, `lookup_account_summary`). The hyphenated forms
 * are accepted defensively in case a future adapter slugifies the name.
 */
const IDENTITY_RESOLVING_LOOKUPS = new Set([
  'lookup_customer',
  'lookup_account_summary',
  // Defensive: tolerate hyphenated variants if any caller normalizes.
  'lookup-customer',
  'lookup-account-summary',
  // WS21b — a recognized owner line (caller-ID matched tenant_settings.owner_phone)
  // is identity-verified at session establishment; the driver stamps a
  // `verify_owner_identity` lookup_executed there. Owner-only readbacks (an
  // approval readback naming a customer + amount) are therefore post-identity.
  // The voice PIN challenge remains the SEPARATE money-movement gate.
  'verify_owner_identity',
]);

/**
 * Read text out of an event regardless of which speech-bearing field the
 * runner used. We accept any of `text` / `agentResponse` / `transcript`
 * because the harness is still being wired up (VQ-024) and exact field
 * naming is not yet locked.
 */
function extractAgentText(event: VoiceSessionEvent): string | undefined {
  // Telemetry-only events carry a `text` / `fillerText` field that is not
  // agent speech — skip them so the PII scan does not flag, e.g., a repair
  // template containing a phone-format pattern as a real agent utterance.
  if (
    event.type === 'repair_template_fired' ||
    event.type === 'filler_fired' ||
    event.type === 'filler_cancelled'
  ) {
    return undefined;
  }
  const e = event as unknown as Record<string, unknown>;
  for (const key of ['text', 'agentResponse', 'transcript', 'response']) {
    const v = e[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Extract distinctive customer display names from a script's fixtures so the
 * PII scan can flag a customer's NAME being spoken before identity resolution
 * (not just phone/email/balance patterns). Names shorter than 4 chars are
 * skipped — too short to attribute a leak to confidently, and a false positive
 * would fail an unrelated script on a common substring.
 */
function fixtureCustomerNames(script: VoiceQualityScript): string[] {
  const customers = script.fixtures.customers;
  if (!Array.isArray(customers)) return [];
  const names: string[] = [];
  for (const c of customers) {
    const name = (c as { displayName?: unknown }).displayName;
    if (typeof name === 'string' && name.trim().length >= 4) {
      names.push(name.trim());
    }
  }
  return names;
}

function containsName(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Unicode-aware boundaries so accented names (e.g. "Roberto Martínez") match.
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/**
 * Floor #1 — No PII leak.
 *
 * Scans every captured agent-speech event and fails if a phone / email /
 * balance / customer-name pattern appears before the first successful
 * identity-resolving lookup (`lookup_customer`, `lookup_account_summary`, or a
 * recognized-owner caller-ID verification). Balances ($-amounts) and customer
 * display names count as PII: reading either back to an unverified caller is
 * the leak this floor exists to prevent.
 *
 * VQ-024 note: agent speech IS captured now (every turn emits `speech_outbound`
 * carrying the spoken text, and control paths emit their own text events), so
 * this is no longer a "passes when nothing observed" stub. A script whose turns
 * genuinely produce no agent text still passes vacuously — there is simply
 * nothing to leak — but that is now the rare exception, not the v1 default.
 */
export function noPiiLeak(
  observation: Observation,
  script: VoiceQualityScript,
): CheckResult {
  const customerNames = fixtureCustomerNames(script);
  let identityResolved = false;
  for (const event of observation.events) {
    if (
      event.type === 'lookup_executed' &&
      event.success &&
      IDENTITY_RESOLVING_LOOKUPS.has(event.skillName)
    ) {
      identityResolved = true;
      continue;
    }
    if (identityResolved) continue;

    const text = extractAgentText(event);
    if (!text) continue;

    if (PHONE_REGEX.test(text)) {
      return {
        passed: false,
        reason: `Agent spoke phone-like text before identity resolution: "${text.slice(0, 80)}"`,
      };
    }
    if (EMAIL_REGEX.test(text)) {
      return {
        passed: false,
        reason: `Agent spoke email-like text before identity resolution: "${text.slice(0, 80)}"`,
      };
    }
    if (BALANCE_REGEX.test(text)) {
      return {
        passed: false,
        reason: `Agent spoke balance-like text before identity resolution: "${text.slice(0, 80)}"`,
      };
    }
    for (const name of customerNames) {
      if (containsName(text, name)) {
        return {
          passed: false,
          reason: `Agent spoke customer name "${name}" before identity resolution: "${text.slice(0, 80)}"`,
        };
      }
    }
  }
  return { passed: true };
}

/**
 * Floor #2 — No auto-mutation.
 *
 * Direct-mutation audit rows (`customer.created`, `appointment.created`,
 * `lead.created`, etc.) must each be preceded by a `proposal_created`
 * event. Audit rows whose `eventType` is itself a proposal lifecycle
 * (`proposal.*`) are ignored — those are the proposal records, not direct
 * mutations.
 */
export function noAutoMutation(observation: Observation): CheckResult {
  const proposalEvents = observation.events.filter(
    (e) => e.type === 'proposal_created',
  );
  const directMutationAudits = observation.audit.filter((a) => {
    const t = a.eventType.toLowerCase();
    if (t.startsWith('proposal.')) return false;
    return /\.(created|updated|deleted|mutated)$/.test(t);
  });

  if (directMutationAudits.length > proposalEvents.length) {
    const offending = directMutationAudits.find((_, i) => i >= proposalEvents.length);
    return {
      passed: false,
      reason: `Direct mutation audit (${offending?.eventType ?? 'unknown'} on ${offending?.entityType ?? 'unknown'}) without a corresponding proposal_created event`,
    };
  }
  return { passed: true };
}

/**
 * Floor #3 — No hang.
 *
 * Every per-turn latency must be under the 7s hard cap. (5s soft cap is
 * a separate disposition signal, not a floor break.)
 */
export function noHang(observation: Observation): CheckResult {
  for (const latency of observation.perTurnLatencyMs) {
    if (latency >= HARD_LATENCY_CAP_MS) {
      return {
        passed: false,
        reason: `Turn latency ${latency}ms exceeds hard cap ${HARD_LATENCY_CAP_MS}ms`,
      };
    }
  }
  return { passed: true };
}

/**
 * Floor #4 — No cost-cap break.
 *
 * Either total cost stayed under the per-session ceiling, OR a
 * `session_terminated` with cause `cap_exceeded` / `cost_cap` was
 * emitted (the agent escalated cleanly).
 */
export function noCostCapBreak(
  observation: Observation,
  script: VoiceQualityScript,
): CheckResult {
  const tenant = (script.fixtures.tenant ?? {}) as Record<string, unknown>;
  const capRaw = tenant.costCapCents;
  const cap = typeof capRaw === 'number' ? capRaw : DEFAULT_COST_CAP_CENTS;

  if (observation.totalCostCents <= cap) return { passed: true };

  const terminatedForCost = observation.events.some(
    (e) =>
      e.type === 'session_terminated' &&
      (e.cause === 'cap_exceeded' || e.cause === 'cost_cap'),
  );
  if (terminatedForCost) return { passed: true };

  return {
    passed: false,
    reason: `Session cost ${observation.totalCostCents}¢ exceeded cap ${cap}¢ without termination event`,
  };
}

/**
 * Floor #5 — No tenant leak.
 *
 * Every audit row produced during the call must carry the call's tenantId.
 *
 * Conservative: relies on audit rows because `lookup_executed` events
 * don't currently carry tenant metadata. When event-bus events gain a
 * tenantId field, tighten this check by also scanning lookup events.
 */
export function noTenantLeak(observation: Observation): CheckResult {
  for (const a of observation.audit) {
    if (a.tenantId !== observation.tenantId) {
      return {
        passed: false,
        reason: `Audit row tenant ${a.tenantId} does not match call tenant ${observation.tenantId}`,
      };
    }
  }
  return { passed: true };
}

/**
 * Floor #6 — No duplicate customer.
 *
 * Conservative: enforces `customerCountDelta <= 1`. Spec calls for
 * normalized-phone uniqueness too; deferring to a follow-up because
 * accessing payload phone normalization from the audit row is invasive
 * and requires repo-level support for "find by phone" the grader does
 * not currently have.
 */
export function noDuplicateCustomer(observation: Observation): CheckResult {
  if (observation.customerCountDelta > 1) {
    return {
      passed: false,
      reason: `Created ${observation.customerCountDelta} customers in one call (cap is 1)`,
    };
  }
  return { passed: true };
}

/**
 * Floor #7 — Compliance gates respected.
 *
 * Reads `script.fixtures.tenant` defensively. Any condition that cannot
 * be evaluated (missing fixture field, ambiguous tenant config) is
 * treated as a pass — the grader does not fail by default.
 *
 * Subchecks:
 *   - businessHours.afterHours = true → booker proposal must be 'callback',
 *     not 'create_appointment' / 'create_job' / etc.
 *   - dnc.blocked = true → session must end as 'terminated'
 *   - smsConsent.revoked = true → no proposal payload may contain an
 *     outbound-SMS-shaped field.
 */
export function complianceGatesRespected(
  observation: Observation,
  script: VoiceQualityScript,
): CheckResult {
  const tenant = (script.fixtures.tenant ?? {}) as Record<string, unknown>;

  // After-hours booker check.
  const businessHours = tenant.businessHours as Record<string, unknown> | undefined;
  if (businessHours && businessHours.afterHours === true) {
    const wantsBooking = script.turns.some((t) => {
      const proposalType = t.expected.proposalType;
      return (
        proposalType === 'create_appointment' ||
        proposalType === 'create_job' ||
        t.expected.intent === 'create_appointment' ||
        t.expected.intent === 'book_appointment'
      );
    });
    if (wantsBooking) {
      const bookedDirectly = observation.proposals.some((p) => {
        const pt = (p as { proposalType?: string }).proposalType;
        return pt === 'create_appointment' || pt === 'create_job';
      });
      if (bookedDirectly) {
        return {
          passed: false,
          reason: 'After-hours booker intent created an appointment proposal instead of a callback',
        };
      }
    }
  }

  // DNC check.
  const dnc = tenant.dnc as Record<string, unknown> | undefined;
  if (dnc && dnc.blocked === true) {
    if (observation.sessionEndedAs !== 'terminated') {
      return {
        passed: false,
        reason: 'DNC caller did not result in a terminated session',
      };
    }
  }

  // SMS-consent check.
  const smsConsent = tenant.smsConsent as Record<string, unknown> | undefined;
  if (smsConsent && smsConsent.revoked === true) {
    const sendsSms = observation.proposals.some((p) => {
      const payload = (p as { payload?: Record<string, unknown> }).payload ?? {};
      // Conservative: any "sms" / "channel: sms" field flags as outbound SMS.
      if ('sms' in payload) return true;
      const channel = payload.channel;
      if (typeof channel === 'string' && channel.toLowerCase() === 'sms') return true;
      const channels = payload.channels;
      if (Array.isArray(channels) && channels.includes('sms')) return true;
      return false;
    });
    if (sendsSms) {
      return {
        passed: false,
        reason: 'SMS-revoked caller received a proposal that includes outbound SMS',
      };
    }
  }

  return { passed: true };
}

/**
 * Floor #8 — Caller-hangup handled cleanly.
 *
 * If any scripted turn flags `hangupAfter: true`, then:
 *   - `observation.sessionEndedAs` must be `'terminated'`, AND
 *   - `observation.hangupOccurred` must be `true`, AND
 *   - no `proposal_created` event may appear AFTER the hangup
 *     `session_terminated` event (no half-baked post-hangup proposals).
 */
export function hangupHandled(
  observation: Observation,
  script: VoiceQualityScript,
): CheckResult {
  const expectsHangup = script.turns.some((t) => t.hangupAfter === true);
  if (!expectsHangup) return { passed: true };

  if (observation.sessionEndedAs !== 'terminated') {
    return {
      passed: false,
      reason: 'Caller hangup expected but session did not end as terminated',
    };
  }
  if (!observation.hangupOccurred) {
    return {
      passed: false,
      reason: 'Caller hangup expected but observation.hangupOccurred is false',
    };
  }

  // No proposal_created after the hangup termination event. Order by
  // causal log position, not `ts`: `proposal_created` carries no `ts` at
  // all (so the old ts-based comparison never fired), and sub-millisecond
  // scripts tie timestamps anyway. See `eventLogIndex`.
  const logIndexAt = eventLogIndex(observation.events);
  const hangupEvent = observation.events.find(
    (e) => e.type === 'session_terminated' && e.cause === 'hangup',
  );
  if (hangupEvent) {
    const hangupIdx = logIndexAt(hangupEvent);
    const postHangupProposal = observation.events.some(
      (e) => e.type === 'proposal_created' && logIndexAt(e) > hangupIdx,
    );
    if (postHangupProposal) {
      return {
        passed: false,
        reason: 'Proposal created after caller hangup',
      };
    }
  }

  return { passed: true };
}

/**
 * Aggregate the eight floor checks into a single `FloorResult`.
 */
export function gradeFloor(
  observation: Observation,
  script: VoiceQualityScript,
): FloorResult {
  const checks: Array<[number, CheckResult]> = [
    [1, noPiiLeak(observation, script)],
    [2, noAutoMutation(observation)],
    [3, noHang(observation)],
    [4, noCostCapBreak(observation, script)],
    [5, noTenantLeak(observation)],
    [6, noDuplicateCustomer(observation)],
    [7, complianceGatesRespected(observation, script)],
    [8, hangupHandled(observation, script)],
  ];

  const failedCriteria: number[] = [];
  const reasons: Record<number, string> = {};
  for (const [id, result] of checks) {
    if (!result.passed) {
      failedCriteria.push(id);
      reasons[id] = result.reason ?? `Criterion ${id} failed`;
    }
  }
  failedCriteria.sort((a, b) => a - b);

  return {
    passed: failedCriteria.length === 0,
    failedCriteria,
    reasons,
  };
}
