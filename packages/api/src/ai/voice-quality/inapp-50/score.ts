/**
 * Verdict / stage / root-cause derivation for the in-app 50-case register.
 *
 * PURE — no repos, no adapter, no clock beyond what the evidence carries — so
 * every rule in the plan's stage / verdict / root-cause tables is unit-
 * testable against synthetic evidence
 * (test/ai/voice-quality/inapp-50/score.test.ts).
 *
 * The whole point of this file is that a case does NOT pass because "some
 * proposal id came back" (the failure mode of the live operator-voice-50
 * probes it replaces): it passes when the ACTION PATH the operator asked for
 * actually happened, with the right payload, on the right entity ids.
 */
import { DateTime } from 'luxon';

import { missingFieldsFor, type Proposal } from '../../../proposals/proposal';
import { validateProposalPayload } from '../../../proposals/contracts';
import { TAU_INT } from '../../agents/customer-calling/transitions';
import type { CaseExpect, RegisterCase } from './register';

// ── Evidence ────────────────────────────────────────────────────────────────

export interface TurnEvidence {
  /** 1-based position in the driven conversation. */
  index: number;
  text: string;
  stateBefore: string;
  stateAfter: string;
  ttsText?: string;
  sideEffectTypes: string[];
  /** `agent.calling.<fromState>.<event>` rows emitted by this turn. */
  auditEventTypes: string[];
  proposalIds: string[];
  /** Session-bus event types seen during this turn. */
  busEventTypes: string[];
  classifiedIntent?: string;
  classifiedConfidence?: number;
  /** `HandleInputResult.trace` once the adapter carries one (R1). */
  trace?: Record<string, unknown>;
  /** True when the driver sent this turn as a disambiguation follow-up. */
  clarificationFollowUp?: boolean;
  /** Set when this turn threw. */
  error?: string;
}

export interface ProposalEvidence {
  id: string;
  proposalType: string;
  status: string;
  missingFields: string[];
  payload: Record<string, unknown>;
  /**
   * Non-undefined ⇒ an APPROVE-TO-FAIL card: the payload fails its contract
   * AND nothing gates it. Always a FAIL, whatever else the case did.
   */
  contractViolation?: string;
}

export interface CaseEvidence {
  turns: TurnEvidence[];
  proposals: ProposalEvidence[];
  /** Every spoken line in order (`tts_play` payload text). */
  spokenLines: string[];
  /**
   * `eventType`s written straight to the tenant's audit repository during the
   * case. Distinct from a turn's `auditEventTypes`, which are the FSM's
   * `audit_log` SIDE EFFECTS: a direct act audits through the repo
   * (`dispatch/routes.ts#triggerEnRoute` →
   * `appointment.en_route_triggered`) and never returns a side effect, so a
   * fired act is invisible in the side-effect stream alone.
   */
  auditEvents: string[];
  finalState: string;
  /** Set when the case threw outside a turn, or timed out. */
  error?: string;
  timedOut?: boolean;
  /** True when the driver actually sent a disambiguation follow-up turn. */
  clarificationTurnSent: boolean;
}

// ── Stage ───────────────────────────────────────────────────────────────────

export type Stage =
  | 'none'
  | 'intent_detected'
  | 'entities_resolved'
  | 'clarification_asked'
  | 'confirmation_asked'
  | 'proposal_created'
  | 'committed'
  | 'answered'
  | 'escalated'
  | 'guarded';

/** Ladder positions for the linear action path; alternates sit outside it. */
const LADDER: Stage[] = [
  'none',
  'intent_detected',
  'entities_resolved',
  'clarification_asked',
  'confirmation_asked',
  'proposal_created',
  'committed',
];

function ladderIndex(stage: Stage): number {
  const i = LADDER.indexOf(stage);
  return i < 0 ? -1 : i;
}

const auditSuffix = (event: string): string => event.split('.').slice(-1)[0] ?? event;

function anyAudit(turns: readonly TurnEvidence[], suffix: string): boolean {
  return turns.some((t) => t.auditEventTypes.some((e) => auditSuffix(e) === suffix));
}

export function escalated(turns: readonly TurnEvidence[]): boolean {
  return turns.some(
    (t) =>
      t.stateAfter === 'escalating' ||
      t.sideEffectTypes.includes('notify_oncall') ||
      t.sideEffectTypes.includes('escalate_with_context') ||
      t.sideEffectTypes.includes('notify_tenant_emergency'),
  );
}

export function guarded(turns: readonly TurnEvidence[]): boolean {
  return (
    anyAudit(turns, 'confirm_without_pending') ||
    anyAudit(turns, 'language_switched') ||
    turns.some((t) => t.trace && t.trace.fallbackReason === 'guard')
  );
}

/**
 * The operator got an ANSWER — the other half of `intent_capture_only`'s "no
 * proposal AND no answer". Three evidence shapes, all of them a real spoken
 * response that hands control back:
 *
 *   1. `lookup_executed` on the session bus (the shared lookup surface).
 *   2. A turn that spoke WITHOUT dispatching the FSM (no audit rows, state
 *      unchanged) on a `lookup_*` intent — the lookup-surface shape.
 *   3. An honest operator not-found (`entity_not_found_operator`): "I couldn't
 *      find a matching appointment for …". That IS the correct outcome for a
 *      reference to a record that does not exist, so counting it as "nothing
 *      landed" would make a case like `cancel-02` — whose whole point is the
 *      honest miss — permanently block gate rule 2.
 */
export function answered(turns: readonly TurnEvidence[]): boolean {
  return turns.some(
    (t) =>
      t.busEventTypes.includes('lookup_executed') ||
      t.auditEventTypes.some((e) => auditSuffix(e) === 'entity_not_found_operator') ||
      (t.sideEffectTypes.includes('tts_play') &&
        t.auditEventTypes.length === 0 &&
        t.proposalIds.length === 0 &&
        t.stateBefore === t.stateAfter &&
        (t.classifiedIntent ?? '').startsWith('lookup_')),
  );
}

/** Furthest stage reached, per the plan's stage table. */
export function deriveStage(
  turns: readonly TurnEvidence[],
  proposals: readonly ProposalEvidence[],
): Stage {
  if (turns.length === 0 || turns.every((t) => t.error)) return 'none';

  let best: Stage = 'none';
  const raise = (stage: Stage): void => {
    if (ladderIndex(stage) > ladderIndex(best)) best = stage;
  };

  for (const turn of turns) {
    const intentDetected =
      turn.auditEventTypes.some((e) => e === 'agent.calling.intent_capture.intent_classified') ||
      (turn.busEventTypes.includes('intent_classified') &&
        (turn.classifiedConfidence ?? 0) >= TAU_INT);
    if (intentDetected) raise('intent_detected');
    if (
      turn.auditEventTypes.some((e) =>
        ['entity_resolved', 'entity_confirm_affirmed'].includes(auditSuffix(e)),
      )
    ) {
      raise('entities_resolved');
    }
    if (
      turn.auditEventTypes.some((e) =>
        ['entity_ambiguous', 'entity_confirm_candidate'].includes(auditSuffix(e)),
      )
    ) {
      raise('clarification_asked');
    }
    if (turn.stateAfter === 'intent_confirm' || turn.stateBefore === 'intent_confirm') {
      raise('confirmation_asked');
    }
    if (turn.proposalIds.length > 0) raise('proposal_created');
    if (
      auditSuffix(turn.auditEventTypes.find((e) => auditSuffix(e) === 'proposal_queued') ?? '') ===
        'proposal_queued' ||
      (turn.stateAfter === 'closing' && proposals.length > 0)
    ) {
      raise('committed');
    }
  }
  if (proposals.length > 0) raise('proposal_created');

  // Alternates. Escalation is terminal and supersedes the ladder; an answer
  // and a guard only stand in for a path that never produced a proposal.
  if (escalated(turns)) return 'escalated';
  if (ladderIndex(best) < ladderIndex('proposal_created') && answered(turns)) return 'answered';
  if (ladderIndex(best) <= ladderIndex('intent_detected') && guarded(turns)) return 'guarded';
  return best;
}

/**
 * `intent_capture_only` — the register's headline FAILURE shape: the assistant
 * understood the request and then produced nothing an operator can act on.
 *
 * Deliberately the SAME rule the release gate recomputes from the artifact
 * (`scripts/inapp-50/lib.mjs#isIntentCaptureOnly`) so the two can never
 * disagree: furthest stage ∈ the three "captured but not acted on" stages,
 * zero proposals, no answer. An honest operator not-found reaches stage
 * `answered` (see `answered`), so a correct miss never trips gate rule 2.
 */
export function isIntentCaptureOnly(stage: Stage, evidence: CaseEvidence): boolean {
  return (
    ['intent_detected', 'clarification_asked', 'confirmation_asked'].includes(stage) &&
    evidence.proposals.length === 0 &&
    !answered(evidence.turns)
  );
}

// ── Verdict + root cause ────────────────────────────────────────────────────

export type Verdict = 'PASS' | 'PARTIAL' | 'DEGRADED' | 'FAIL';
export type RootCauseCategory =
  | 'intent'
  | 'slot_capture'
  | 'proposal_generation'
  | 'fallback'
  | 'infra';

export interface RootCause {
  category: RootCauseCategory;
  /** One line naming the evidence — audit event, missing key, spoken line. */
  detail: string;
}

export interface CaseScore {
  verdict: Verdict;
  reason: string;
  stage: Stage;
  rootCause: RootCause | null;
  /** Every unmet expectation, in evaluation order. */
  failures: string[];
}

/**
 * The voice-payload contract net, vitest-free (the test-tree helper
 * `test/voice/helpers/voice-proposal-contract.ts` registers an `afterEach`,
 * which cannot live in `src/`). Same rule:
 *   valid payload                   → fine
 *   invalid payload + missingFields → fine (gated; operator completes it)
 *   invalid payload + no gate       → THE BUG (approve throws at execution)
 */
export function proposalContractViolation(proposal: Proposal): string | undefined {
  const result = validateProposalPayload(proposal.proposalType, proposal.payload);
  if (result.valid) return undefined;
  if (missingFieldsFor(proposal).length > 0) return undefined;
  return (
    `voice-minted '${proposal.proposalType}' failed validateProposalPayload with no ` +
    `missingFields gate: ${(result.errors ?? []).join('; ')}`
  );
}

/** Fixture keys look like `customer.garcia`; anything else compares literally. */
function resolveExpectedValue(
  value: string | number | boolean,
  fixtureIds: Record<string, string>,
): string | number | boolean {
  if (typeof value !== 'string') return value;
  return fixtureIds[value] ?? value;
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function lastSpoken(evidence: CaseEvidence): string {
  return evidence.spokenLines.length > 0
    ? evidence.spokenLines[evidence.spokenLines.length - 1]
    : '';
}

function spokenHaystack(evidence: CaseEvidence, anyTurn: boolean | undefined): string {
  return anyTurn ? evidence.spokenLines.join('\n') : lastSpoken(evidence);
}

/** ISO weekday (1=Mon … 7=Sun) of an ISO instant, in the tenant's zone. */
export function isoWeekdayInZone(iso: unknown, timezone: string): number | undefined {
  if (typeof iso !== 'string' && !(iso instanceof Date)) return undefined;
  const dt =
    iso instanceof Date
      ? DateTime.fromJSDate(iso, { zone: timezone })
      : DateTime.fromISO(iso, { zone: timezone });
  return dt.isValid ? dt.weekday : undefined;
}

export interface ScoreOptions {
  /** Tenant IANA zone for `scheduledStartWeekday`. */
  timezone?: string;
}

const DEFAULT_TIMEZONE = 'America/Phoenix';

/**
 * Evaluate one case's `expect` block against the evidence. Returns every
 * unmet expectation (not just the first) so triage sees the whole picture.
 */
export function evaluateExpectations(
  expect: CaseExpect,
  evidence: CaseEvidence,
  fixtureIds: Record<string, string>,
  options: ScoreOptions = {},
): string[] {
  const failures: string[] = [];
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const proposals = evidence.proposals;
  const actionable = proposals.filter((p) => p.proposalType !== 'voice_clarification');
  const primary =
    (expect.proposalType
      ? proposals.find((p) => p.proposalType === expect.proposalType)
      : undefined) ?? actionable[0] ?? proposals[0];

  // ── Outcome shape ─────────────────────────────────────────────────────
  switch (expect.outcome) {
    case 'proposal':
      if (!primary) failures.push('no proposal was created');
      else if (expect.proposalType && primary.proposalType !== expect.proposalType) {
        failures.push(
          `proposalType '${primary.proposalType}' ≠ expected '${expect.proposalType}'`,
        );
      }
      break;
    case 'lookup_answer':
      if (!answered(evidence.turns)) failures.push('no lookup answer was spoken');
      break;
    case 'clarification_question':
      if (!/more than one|which one|which /i.test(spokenHaystack(evidence, true))) {
        failures.push('no which-one clarification was asked');
      }
      break;
    case 'not_found':
      if (proposals.length > 0) failures.push('a proposal was minted for a not-found reference');
      break;
    case 'escalation':
      if (!escalated(evidence.turns)) failures.push('the case did not escalate');
      break;
    case 'direct_act':
      if (actionable.length > 0) {
        failures.push(`a proposal ('${actionable[0].proposalType}') replaced the direct act`);
      }
      if (proposals.some((p) => p.proposalType === 'voice_clarification')) {
        failures.push('a dead voice_clarification card replaced the direct act');
      }
      break;
    case 'guard':
      if (!guarded(evidence.turns)) failures.push('no guard fired');
      break;
  }

  // ── Proposal-level expectations ───────────────────────────────────────
  if (expect.status !== undefined && primary && primary.status !== expect.status) {
    failures.push(`proposal status '${primary.status}' ≠ expected '${expect.status}'`);
  }
  if (expect.payloadContains) {
    for (const [key, raw] of Object.entries(expect.payloadContains)) {
      const wanted = resolveExpectedValue(raw, fixtureIds);
      const actual = primary?.payload[key];
      if (actual === undefined) failures.push(`payload.${key} is absent`);
      else if (String(actual) !== String(wanted)) {
        failures.push(`payload.${key} = ${JSON.stringify(actual)} ≠ ${JSON.stringify(wanted)}`);
      }
    }
  }
  if (expect.payloadHas) {
    for (const key of expect.payloadHas) {
      if (!isPresent(primary?.payload[key])) failures.push(`payload.${key} is absent or empty`);
    }
  }
  if (expect.missingFieldsContains) {
    for (const field of expect.missingFieldsContains) {
      if (!primary?.missingFields.includes(field)) {
        failures.push(`missingFields does not gate on '${field}'`);
      }
    }
  }
  if (expect.proposalCount !== undefined && proposals.length !== expect.proposalCount) {
    failures.push(`proposalCount ${proposals.length} ≠ expected ${expect.proposalCount}`);
  }
  if (expect.forbidProposalTypes) {
    for (const type of expect.forbidProposalTypes) {
      if (proposals.some((p) => p.proposalType === type)) {
        failures.push(`forbidden proposal type '${type}' was minted`);
      }
    }
  }
  if (expect.scheduledStartWeekday !== undefined) {
    const weekday = isoWeekdayInZone(primary?.payload.scheduledStart, timezone);
    if (weekday !== expect.scheduledStartWeekday) {
      failures.push(
        `scheduledStart weekday ${weekday ?? 'unresolved'} ≠ expected ` +
          `${expect.scheduledStartWeekday} (${timezone})`,
      );
    }
  }

  // ── Spoken copy ───────────────────────────────────────────────────────
  if (expect.spokenMatches) {
    const hay = spokenHaystack(evidence, expect.anyTurn);
    if (!new RegExp(expect.spokenMatches, 'i').test(hay)) {
      failures.push(`spoken line did not match /${expect.spokenMatches}/i: "${hay}"`);
    }
  }
  if (expect.forbidSpoken) {
    const hay = spokenHaystack(evidence, true);
    if (new RegExp(expect.forbidSpoken, 'i').test(hay)) {
      failures.push(`spoken line matched forbidden /${expect.forbidSpoken}/i`);
    }
  }

  // ── Side effects + states ─────────────────────────────────────────────
  const seenSideEffects = new Set(evidence.turns.flatMap((t) => t.sideEffectTypes));
  for (const fx of expect.requireSideEffects ?? []) {
    if (!seenSideEffects.has(fx)) failures.push(`required side effect '${fx}' never fired`);
  }
  for (const fx of expect.forbidSideEffects ?? []) {
    if (seenSideEffects.has(fx)) failures.push(`forbidden side effect '${fx}' fired`);
  }
  if (expect.requireAuditEvents) {
    // Both streams: FSM `audit_log` side effects AND rows written straight to
    // the audit repository (see CaseEvidence.auditEvents).
    const seenAudit = new Set([
      ...evidence.turns.flatMap((t) => t.auditEventTypes),
      ...evidence.auditEvents,
    ]);
    for (const event of expect.requireAuditEvents) {
      if (!seenAudit.has(event)) failures.push(`required audit event '${event}' was never written`);
    }
  }
  if (expect.allowedStates && !expect.allowedStates.includes(evidence.finalState)) {
    failures.push(
      `final state '${evidence.finalState}' ∉ [${expect.allowedStates.join(', ')}]`,
    );
  }
  if (expect.stateAfterTurn) {
    for (const [turnKey, wanted] of Object.entries(expect.stateAfterTurn)) {
      const turn = evidence.turns.find((t) => t.index === Number(turnKey));
      if (!turn) failures.push(`turn ${turnKey} was never sent`);
      else if (turn.stateAfter !== wanted) {
        failures.push(`state after turn ${turnKey} = '${turn.stateAfter}' ≠ '${wanted}'`);
      }
    }
  }
  if (expect.requireClarificationTurn && !evidence.clarificationTurnSent) {
    failures.push('no disambiguation follow-up was asked for (and answered)');
  }

  return failures;
}

// ── Fallback / root-cause signals ───────────────────────────────────────────

const UNAVAILABLE_LINE_RE =
  /trouble pulling|let me get a person|couldn't pull (that|it) up|can't help with that|not able to pull/i;

interface Signals {
  intentDetected: boolean;
  intentMismatch: boolean;
  classifierFailure: boolean;
  clarificationMinted: boolean;
  unexpectedEscalation: boolean;
  unexpectedGuard: boolean;
  repromptLoop: boolean;
  lookupUnavailable: boolean;
  entityNotFound: boolean;
  ambiguityUnresolved: boolean;
}

function deriveSignals(c: RegisterCase, evidence: CaseEvidence): Signals {
  const turns = evidence.turns;
  const repromptTurns = turns.filter((t) => anyAudit([t], 'reprompt')).length;
  return {
    intentDetected: turns.some(
      (t) =>
        t.auditEventTypes.includes('agent.calling.intent_capture.intent_classified') ||
        (t.classifiedConfidence ?? 0) >= TAU_INT,
    ),
    intentMismatch: turns.some(
      (t) =>
        (t.classifiedConfidence ?? 0) >= TAU_INT &&
        t.classifiedIntent !== undefined &&
        t.classifiedIntent !== c.intent &&
        t.classifiedIntent !== 'confirm',
    ),
    classifierFailure: turns.some((t) =>
      t.auditEventTypes.some((e) => /classifier_.*_failure/.test(e)),
    ),
    clarificationMinted: evidence.proposals.some((p) => p.proposalType === 'voice_clarification'),
    unexpectedEscalation: escalated(turns) && c.expect.outcome !== 'escalation',
    unexpectedGuard: guarded(turns) && c.expect.outcome !== 'guard',
    repromptLoop: repromptTurns > 0 && c.expect.outcome !== 'guard',
    lookupUnavailable:
      UNAVAILABLE_LINE_RE.test(evidence.spokenLines.join('\n')) &&
      ['lookup_answer', 'clarification_question', 'not_found'].includes(c.expect.outcome),
    entityNotFound:
      anyAudit(turns, 'entity_not_found') ||
      turns.some((t) => t.trace?.resolution === 'not_found'),
    ambiguityUnresolved:
      anyAudit(turns, 'entity_ambiguous') && evidence.proposals.length === 0 &&
      c.expect.outcome === 'proposal',
  };
}

function deriveRootCause(
  c: RegisterCase,
  failures: string[],
  signals: Signals,
): RootCause {
  const failureText = failures.join('; ');

  if (signals.classifierFailure) {
    return { category: 'intent', detail: `classifier failure audit fired: ${failureText}` };
  }
  if (!signals.intentDetected) {
    return {
      category: 'intent',
      detail: `no intent classified at or above τ_int=${TAU_INT} — ${failureText}`,
    };
  }
  if (signals.intentMismatch) {
    return {
      category: 'intent',
      detail: `classified intent ≠ register intent '${c.intent}' — ${failureText}`,
    };
  }

  // A dead clarification card FOR A LOOKUP / direct act is the fallback the
  // plan calls out; on a mapped mutation intent the same card is a
  // proposal-generation degrade.
  if (signals.clarificationMinted) {
    return c.expect.outcome === 'proposal'
      ? {
          category: 'proposal_generation',
          detail: `voice_clarification minted instead of '${c.expect.proposalType}' — ${failureText}`,
        }
      : {
          category: 'fallback',
          detail: `dead voice_clarification card for a ${c.expect.outcome} — ${failureText}`,
        };
  }
  if (failures.some((f) => /proposalType '.*' ≠ expected/.test(f))) {
    return { category: 'proposal_generation', detail: failureText };
  }
  if (signals.unexpectedEscalation) {
    return { category: 'fallback', detail: `unexpected escalation / on-call page — ${failureText}` };
  }
  if (signals.lookupUnavailable) {
    return {
      category: 'fallback',
      detail: `lookup-unavailable / handoff copy spoken to an entitled operator — ${failureText}`,
    };
  }
  if (signals.unexpectedGuard || signals.repromptLoop) {
    return { category: 'fallback', detail: `unexpected reprompt / guard — ${failureText}` };
  }
  if (signals.entityNotFound && c.fixtureRefs.length > 0) {
    return {
      category: 'slot_capture',
      detail: `entity_not_found on a seeded fixture (${c.fixtureRefs.join(', ')}) — ${failureText}`,
    };
  }
  if (signals.ambiguityUnresolved) {
    return {
      category: 'slot_capture',
      detail: `ambiguity was never resolved by the follow-up — ${failureText}`,
    };
  }
  if (
    failures.some((f) =>
      /payload\.[A-Za-z]+ is absent|payload\.[A-Za-z]+ = |missingFields|scheduledStart weekday/.test(
        f,
      ),
    )
  ) {
    return { category: 'slot_capture', detail: failureText };
  }
  if (failures.some((f) => /no proposal was created/.test(f))) {
    return {
      category: 'proposal_generation',
      detail: `intent captured but nothing was minted — ${failureText}`,
    };
  }
  if (
    failures.some((f) =>
      /no lookup answer|which-one|did not escalate|no guard fired|required audit event|replaced the direct act/.test(
        f,
      ),
    )
  ) {
    return { category: 'fallback', detail: failureText };
  }
  // Only the SPOKEN copy is wrong — the act itself landed. That is the
  // surface answering with something other than the expected line, which is
  // the `fallback` family, not a drafting defect.
  if (failures.every((f) => /^spoken line (did not match|matched forbidden)/.test(f))) {
    return { category: 'fallback', detail: failureText };
  }
  return { category: 'proposal_generation', detail: failureText };
}

/** Score one case against its register expectation. */
export function scoreCase(
  c: RegisterCase,
  evidence: CaseEvidence,
  fixtureIds: Record<string, string>,
  options: ScoreOptions = {},
): CaseScore {
  const stage = deriveStage(evidence.turns, evidence.proposals);

  // 1. Contract violations and exceptions are FAILs regardless of anything
  //    the case otherwise achieved.
  const violation = evidence.proposals.find((p) => p.contractViolation);
  if (violation) {
    return {
      verdict: 'FAIL',
      reason: 'voice-proposal contract violation',
      stage,
      rootCause: { category: 'proposal_generation', detail: violation.contractViolation! },
      failures: [violation.contractViolation!],
    };
  }
  const thrown = evidence.error ?? evidence.turns.find((t) => t.error)?.error;
  if (thrown) {
    return {
      verdict: 'FAIL',
      reason: evidence.timedOut ? 'case timed out' : 'exception during the turn',
      stage: evidence.turns.length === 0 ? 'none' : stage,
      rootCause: { category: 'infra', detail: thrown },
      failures: [thrown],
    };
  }
  const contractAudit = evidence.turns.find((t) =>
    t.auditEventTypes.some((e) => /payload_contract_failed|proposal_persist_failed/.test(e)),
  );
  if (contractAudit) {
    const event = contractAudit.auditEventTypes.find((e) =>
      /payload_contract_failed|proposal_persist_failed/.test(e),
    )!;
    return {
      verdict: 'FAIL',
      reason: event,
      stage,
      rootCause: { category: 'proposal_generation', detail: `audit ${event}` },
      failures: [`audit ${event}`],
    };
  }

  // 2. Expectations.
  const failures = evaluateExpectations(c.expect, evidence, fixtureIds, options);
  if (failures.length === 0) {
    const proposal = evidence.proposals[0];
    return {
      verdict: 'PASS',
      reason: proposal
        ? `proposal:${proposal.proposalType}`
        : `${c.expect.outcome}:${stage}`,
      stage,
      rootCause: null,
      failures: [],
    };
  }

  // 3. DEGRADED when a FALLBACK path replaced the expected one; PARTIAL when
  //    the expected path ran but stopped short or landed a wrong field.
  const signals = deriveSignals(c, evidence);
  const rootCause = deriveRootCause(c, failures, signals);
  const fellBack =
    signals.clarificationMinted ||
    signals.unexpectedEscalation ||
    signals.unexpectedGuard ||
    signals.repromptLoop ||
    signals.lookupUnavailable ||
    !signals.intentDetected ||
    signals.classifierFailure ||
    signals.intentMismatch;

  return {
    verdict: fellBack ? 'DEGRADED' : 'PARTIAL',
    reason: failures[0],
    stage,
    rootCause,
    failures,
  };
}

// ── CHAT surfaces ───────────────────────────────────────────────────────────
//
// `POST /api/assistant/chat` is the surface an operator actually types on (and
// the one the web assistant page posts mic transcripts to, `inputMode:
// 'voice'`). It reaches the SAME classifier, the SAME task-handler registry,
// the SAME entity resolver and the SAME lookup dispatch as the voice FSM — but
// it has no FSM, so an entire family of the register's expectations is
// meaningless here and scoring them would manufacture failures the product does
// not have.
//
// IGNORED on chat, deliberately, each because it names an `InAppVoiceAdapter`
// concept with no counterpart on an HTTP request/response:
//   `stateAfterTurn`, `allowedStates`  — there is no session state machine.
//   `requireSideEffects`/`forbidSideEffects` — `SideEffect` is the FSM's
//       return channel; chat's effects are repository writes, which are
//       checked directly (proposals, `requireAuditEvents`).
// Everything that describes the OUTCOME — which proposal, with which payload,
// on which entity id, gated on what, and what the operator was told — is
// scored exactly as hard as it is on voice.

/** One `POST /api/assistant/chat` round trip. */
export interface ChatTurnEvidence {
  /** 1-based position in the driven conversation. */
  index: number;
  text: string;
  inputMode: 'voice' | 'text';
  httpStatus: number;
  /** `message.content` — chat's equivalent of a spoken line. */
  content: string;
  taskType?: string;
  model?: string;
  degraded?: boolean;
  fallbackStage?: string;
  /** `AssistantLookupReply.outcome`, when this turn took the lookup path. */
  lookupOutcome?: string;
  /** `message.proposal` — the UI card, NOT the persisted row. */
  card?: {
    id?: string;
    type?: string;
    status?: string;
    missingFields?: string[];
  };
  /** Every proposal id in the tenant repo AFTER this turn. */
  proposalIds: string[];
  clarificationFollowUp?: boolean;
  error?: string;
}

export interface ChatCaseEvidence {
  turns: ChatTurnEvidence[];
  /** The persisted rows — the authoritative record of what was drafted. */
  proposals: ProposalEvidence[];
  /** `message.content` per turn, in order. */
  replies: string[];
  /** `eventType`s written to the tenant's audit repository during the case. */
  auditEvents: string[];
  error?: string;
  timedOut?: boolean;
  clarificationTurnSent: boolean;
}

/**
 * taskTypes that mean "the route did NOT recognize an actionable intent".
 * Everything else (`assistant.<intent>`, `assistant.lookup.*`,
 * `assistant.en_route`, `assistant.chain`, `assistant.unhandled.<intent>`,
 * `assistant.entity_resolution`, `assistant.voice_approval_refused`) means the
 * classifier produced an intent the route then routed — well or badly.
 */
const CHAT_UNRECOGNIZED_TASK_TYPES = new Set([
  'assistant.not_understood',
  'assistant.intent_failed',
  'assistant.general',
  'assistant.invoice',
  'assistant.schedule',
  'assistant.followup',
  'assistant.estimate',
]);

function chatOk(turn: ChatTurnEvidence): boolean {
  return !turn.error && turn.httpStatus >= 200 && turn.httpStatus < 300;
}

/**
 * The route ANSWERED rather than drafting something.
 *
 * Three shapes, all of them a real reply that hands control back:
 *   1. a lookup / deterministic data query (`assistant.lookup.*`,
 *      `assistant.query.*`),
 *   2. the en-route direct act,
 *   3. an honest not-found (`assistant.<intent>.not_found`) — "I couldn't find
 *      a matching appointment for Patel" IS the correct outcome for a
 *      reference to a record that does not exist, so counting it as "nothing
 *      landed" would make the register's `cancel-02` permanently trip gate
 *      rule 2 for doing exactly the right thing. Same allowance the voice
 *      scorer makes for `entity_not_found_operator` (see `answered`).
 */
export function chatAnswered(evidence: ChatCaseEvidence): boolean {
  return evidence.turns.some(
    (t) =>
      chatOk(t) &&
      typeof t.taskType === 'string' &&
      (t.taskType.startsWith('assistant.lookup.') ||
        t.taskType.startsWith('assistant.query.') ||
        t.taskType.endsWith('.not_found') ||
        t.taskType === 'assistant.en_route'),
  );
}

/** A deterministic policy refusal fired (chat's only guard shape). */
export function chatGuarded(evidence: ChatCaseEvidence): boolean {
  return evidence.turns.some(
    (t) =>
      chatOk(t) &&
      (t.taskType === 'assistant.voice_approval_refused' ||
        (typeof t.taskType === 'string' && t.taskType.startsWith('assistant.unhandled.'))),
  );
}

/** The reply asked the ONE clarification question (which-one / gated ask). */
export function chatAskedClarification(evidence: ChatCaseEvidence): boolean {
  return (
    evidence.turns.some((t) => t.lookupOutcome === 'ambiguous') ||
    /more than one|which one|which (?:of|[A-Z])|did you mean/i.test(evidence.replies.join('\n'))
  );
}

/**
 * Furthest stage reached on a chat surface, mapped onto the SAME ladder the
 * voice run reports so one artifact, one dashboard and one gate read both.
 *
 * `confirmation_asked` never appears: chat has no spoken readback, a drafted
 * card IS the confirmation, and it is committed by a screen tap. `committed`
 * means the row came back already approved (an auto-approving type at or above
 * the threshold), which is the only "and it went through" chat has.
 */
export function deriveChatStage(evidence: ChatCaseEvidence): Stage {
  if (evidence.turns.length === 0 || evidence.turns.every((t) => !chatOk(t))) return 'none';

  let best: Stage = 'none';
  const raise = (stage: Stage): void => {
    if (ladderIndex(stage) > ladderIndex(best)) best = stage;
  };

  for (const turn of evidence.turns) {
    if (!chatOk(turn)) continue;
    if (turn.taskType && !CHAT_UNRECOGNIZED_TASK_TYPES.has(turn.taskType)) {
      raise('intent_detected');
    }
    if (turn.proposalIds.length > 0) raise('proposal_created');
  }
  if (evidence.proposals.length > 0) raise('proposal_created');
  if (chatAskedClarification(evidence) && ladderIndex(best) < ladderIndex('proposal_created')) {
    raise('clarification_asked');
  }
  if (evidence.proposals.some((p) => p.status === 'approved')) raise('committed');

  if (ladderIndex(best) < ladderIndex('proposal_created') && chatAnswered(evidence)) {
    return 'answered';
  }
  if (ladderIndex(best) <= ladderIndex('intent_detected') && chatGuarded(evidence)) return 'guarded';
  return best;
}

/** The chat twin of `isIntentCaptureOnly` — same rule, chat's evidence. */
export function isChatIntentCaptureOnly(stage: Stage, evidence: ChatCaseEvidence): boolean {
  return (
    ['intent_detected', 'clarification_asked', 'confirmation_asked'].includes(stage) &&
    evidence.proposals.length === 0 &&
    !chatAnswered(evidence)
  );
}

function lastReply(evidence: ChatCaseEvidence): string {
  return evidence.replies.length > 0 ? evidence.replies[evidence.replies.length - 1] : '';
}

function chatHaystack(evidence: ChatCaseEvidence, anyTurn: boolean | undefined): string {
  return anyTurn ? evidence.replies.join('\n') : lastReply(evidence);
}

/**
 * Evaluate one case's `expect` block against CHAT evidence.
 *
 * Same contract as `evaluateExpectations`: pure, returns EVERY unmet
 * expectation rather than the first, and resolves fixture keys through
 * `fixtureIds` before comparing.
 */
export function evaluateChatExpectations(
  expect: CaseExpect,
  evidence: ChatCaseEvidence,
  fixtureIds: Record<string, string>,
  options: ScoreOptions = {},
): string[] {
  const failures: string[] = [];
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const proposals = evidence.proposals;
  const actionable = proposals.filter((p) => p.proposalType !== 'voice_clarification');
  const primary =
    (expect.proposalType
      ? proposals.find((p) => p.proposalType === expect.proposalType)
      : undefined) ?? actionable[0] ?? proposals[0];

  // An `escalation` that came back as an emergency_dispatch DRAFT is the
  // correct chat outcome (see the switch below); remember it so the spoken
  // check further down does not then demand the FSM's escalation copy.
  let escalationSatisfiedByProposal = false;

  switch (expect.outcome) {
    case 'proposal':
      if (!primary) {
        // The card and the taskType are the route's OWN claim about what it
        // drafted. When the repo has nothing but one of those says otherwise,
        // that is a persistence bug worth naming precisely rather than the
        // flat "nothing happened".
        const claimed = evidence.turns.find(
          (t) => t.card?.type || (t.taskType ?? '').startsWith('assistant.'),
        );
        failures.push(
          claimed?.card?.type
            ? `no proposal row exists although the reply carried a '${claimed.card.type}' card`
            : 'no proposal was created',
        );
      } else if (expect.proposalType && primary.proposalType !== expect.proposalType) {
        failures.push(
          `proposalType '${primary.proposalType}' ≠ expected '${expect.proposalType}'`,
        );
      }
      break;
    case 'lookup_answer':
      if (!chatAnswered(evidence)) failures.push('no lookup answer was returned');
      if (actionable.length > 0) {
        failures.push(`a proposal ('${actionable[0].proposalType}') replaced the read-only answer`);
      }
      break;
    case 'clarification_question':
      if (!chatAskedClarification(evidence)) failures.push('no which-one clarification was asked');
      break;
    case 'not_found':
      if (proposals.length > 0) failures.push('a proposal was minted for a not-found reference');
      break;
    case 'escalation':
      // Chat has NO on-call side effect — `notify_oncall` is an FSM effect and
      // the route never pages anyone. The two honest chat outcomes for an
      // emergency are: draft the `emergency_dispatch` proposal for a human to
      // act on, or say the emergency words. Anything else means the emergency
      // vanished into a generic reply.
      escalationSatisfiedByProposal = proposals.some(
        (p) => p.proposalType === 'emergency_dispatch',
      );
      if (
        !escalationSatisfiedByProposal &&
        !(expect.spokenMatches &&
          new RegExp(expect.spokenMatches, 'i').test(evidence.replies.join('\n')))
      ) {
        failures.push(
          'neither an emergency_dispatch proposal nor emergency copy came back for an emergency',
        );
      }
      break;
    case 'direct_act':
      if (actionable.length > 0) {
        failures.push(`a proposal ('${actionable[0].proposalType}') replaced the direct act`);
      }
      if (proposals.some((p) => p.proposalType === 'voice_clarification')) {
        failures.push('a dead voice_clarification card replaced the direct act');
      }
      break;
    case 'guard':
      // Chat's guard is "nothing was written and the operator was told
      // something honest" — the spoken/forbidSpoken checks below carry the
      // copy half; this half is the one that matters most.
      if (proposals.length > 0) {
        failures.push(`a proposal ('${proposals[0].proposalType}') was minted on a guard turn`);
      }
      break;
  }

  // ── Proposal-level expectations (against the PERSISTED row) ───────────
  if (expect.status !== undefined && primary && primary.status !== expect.status) {
    failures.push(`proposal status '${primary.status}' ≠ expected '${expect.status}'`);
  }
  if (expect.payloadContains) {
    for (const [key, raw] of Object.entries(expect.payloadContains)) {
      const wanted = resolveExpectedValue(raw, fixtureIds);
      const actual = primary?.payload[key];
      if (actual === undefined) failures.push(`payload.${key} is absent`);
      else if (String(actual) !== String(wanted)) {
        failures.push(`payload.${key} = ${JSON.stringify(actual)} ≠ ${JSON.stringify(wanted)}`);
      }
    }
  }
  if (expect.payloadHas) {
    for (const key of expect.payloadHas) {
      if (!isPresent(primary?.payload[key])) failures.push(`payload.${key} is absent or empty`);
    }
  }
  if (expect.missingFieldsContains) {
    for (const field of expect.missingFieldsContains) {
      if (!primary?.missingFields.includes(field)) {
        failures.push(`missingFields does not gate on '${field}'`);
      }
    }
  }
  if (expect.proposalCount !== undefined && proposals.length !== expect.proposalCount) {
    failures.push(`proposalCount ${proposals.length} ≠ expected ${expect.proposalCount}`);
  }
  if (expect.forbidProposalTypes) {
    for (const type of expect.forbidProposalTypes) {
      if (proposals.some((p) => p.proposalType === type)) {
        failures.push(`forbidden proposal type '${type}' was minted`);
      }
    }
  }
  if (expect.scheduledStartWeekday !== undefined) {
    const weekday = isoWeekdayInZone(primary?.payload.scheduledStart, timezone);
    if (weekday !== expect.scheduledStartWeekday) {
      failures.push(
        `scheduledStart weekday ${weekday ?? 'unresolved'} ≠ expected ` +
          `${expect.scheduledStartWeekday} (${timezone})`,
      );
    }
  }

  // ── Reply copy ────────────────────────────────────────────────────────
  if (expect.spokenMatches && !escalationSatisfiedByProposal) {
    const hay = chatHaystack(evidence, expect.anyTurn);
    if (!new RegExp(expect.spokenMatches, 'i').test(hay)) {
      failures.push(`reply did not match /${expect.spokenMatches}/i: "${hay}"`);
    }
  }
  if (expect.forbidSpoken) {
    const hay = evidence.replies.join('\n');
    if (new RegExp(expect.forbidSpoken, 'i').test(hay)) {
      failures.push(`reply matched forbidden /${expect.forbidSpoken}/i`);
    }
  }

  // ── Audited acts ──────────────────────────────────────────────────────
  if (expect.requireAuditEvents) {
    const seenAudit = new Set(evidence.auditEvents);
    for (const event of expect.requireAuditEvents) {
      if (!seenAudit.has(event)) failures.push(`required audit event '${event}' was never written`);
    }
  }
  if (expect.requireClarificationTurn && !evidence.clarificationTurnSent) {
    failures.push('no disambiguation follow-up was asked for (and answered)');
  }

  return failures;
}

interface ChatSignals {
  http5xx: boolean;
  unrecognized: boolean;
  unhandledCapability: boolean;
  approvalRefused: boolean;
  degradedEnvelope: boolean;
  lookupFailedOrRefused: boolean;
  clarificationMinted: boolean;
  clarificationAsked: boolean;
}

function deriveChatSignals(c: RegisterCase, evidence: ChatCaseEvidence): ChatSignals {
  const turns = evidence.turns;
  return {
    http5xx: turns.some((t) => t.httpStatus >= 500),
    unrecognized: turns.some(
      (t) => chatOk(t) && t.taskType !== undefined && CHAT_UNRECOGNIZED_TASK_TYPES.has(t.taskType),
    ),
    unhandledCapability: turns.some((t) => (t.taskType ?? '').startsWith('assistant.unhandled.')),
    approvalRefused:
      turns.some((t) => t.taskType === 'assistant.voice_approval_refused') &&
      c.expect.outcome !== 'guard',
    degradedEnvelope: turns.some((t) => t.degraded === true),
    lookupFailedOrRefused: turns.some(
      (t) => t.lookupOutcome === 'failed' || t.lookupOutcome === 'refused',
    ),
    clarificationMinted: evidence.proposals.some((p) => p.proposalType === 'voice_clarification'),
    clarificationAsked: chatAskedClarification(evidence),
  };
}

function deriveChatRootCause(
  c: RegisterCase,
  expect: CaseExpect,
  failures: string[],
  signals: ChatSignals,
): RootCause {
  const failureText = failures.join('; ');

  if (signals.http5xx) {
    return { category: 'infra', detail: `chat route returned 5xx — ${failureText}` };
  }
  if (signals.degradedEnvelope) {
    return {
      category: 'fallback',
      detail: `degraded reply envelope (fallbackStage) — ${failureText}`,
    };
  }
  if (signals.unrecognized) {
    return {
      category: 'intent',
      detail:
        `the turn fell through to the generic reply — no intent branch claimed intent ` +
        `'${c.intent}' — ${failureText}`,
    };
  }
  if (signals.unhandledCapability) {
    return {
      category: 'fallback',
      detail: `honest unmapped-capability refusal for '${c.intent}' — ${failureText}`,
    };
  }
  if (signals.approvalRefused) {
    return {
      category: 'fallback',
      detail: `voice-mode approval refusal fired on a non-approval turn — ${failureText}`,
    };
  }
  if (signals.clarificationMinted) {
    return expect.outcome === 'proposal'
      ? {
          category: 'proposal_generation',
          detail: `voice_clarification minted instead of '${expect.proposalType}' — ${failureText}`,
        }
      : {
          category: 'fallback',
          detail: `dead voice_clarification card for a ${expect.outcome} — ${failureText}`,
        };
  }
  if (signals.lookupFailedOrRefused) {
    return {
      category: 'fallback',
      detail: `lookup came back failed/refused for an entitled operator — ${failureText}`,
    };
  }
  if (failures.some((f) => /proposalType '.*' ≠ expected/.test(f))) {
    return { category: 'proposal_generation', detail: failureText };
  }
  if (
    signals.clarificationAsked &&
    expect.outcome === 'proposal' &&
    failures.some((f) => /no proposal|payload\.|missingFields/.test(f))
  ) {
    return {
      category: 'slot_capture',
      detail: `the clarification was asked but never resolved into slots — ${failureText}`,
    };
  }
  if (
    failures.some((f) =>
      /payload\.[A-Za-z]+ is absent|payload\.[A-Za-z]+ = |missingFields|scheduledStart weekday|proposal status/.test(
        f,
      ),
    )
  ) {
    return { category: 'slot_capture', detail: failureText };
  }
  if (failures.some((f) => /no proposal|proposalCount|no proposal row exists/.test(f))) {
    return { category: 'proposal_generation', detail: failureText };
  }
  if (
    failures.some((f) =>
      /no lookup answer|which-one|emergency|required audit event|replaced the (direct act|read-only answer)|was minted on a guard turn|minted for a not-found/.test(
        f,
      ),
    )
  ) {
    return { category: 'fallback', detail: failureText };
  }
  if (failures.every((f) => /^reply (did not match|matched forbidden)/.test(f))) {
    return { category: 'fallback', detail: failureText };
  }
  return { category: 'proposal_generation', detail: failureText };
}

/** Score one case against its (possibly chat-overridden) expectation. */
export function scoreChatCase(
  c: RegisterCase,
  expect: CaseExpect,
  evidence: ChatCaseEvidence,
  fixtureIds: Record<string, string>,
  options: ScoreOptions = {},
): CaseScore {
  const stage = deriveChatStage(evidence);

  const violation = evidence.proposals.find((p) => p.contractViolation);
  if (violation) {
    return {
      verdict: 'FAIL',
      reason: 'voice-proposal contract violation',
      stage,
      rootCause: { category: 'proposal_generation', detail: violation.contractViolation! },
      failures: [violation.contractViolation!],
    };
  }
  const thrown = evidence.error ?? evidence.turns.find((t) => t.error)?.error;
  if (thrown) {
    return {
      verdict: 'FAIL',
      reason: evidence.timedOut ? 'case timed out' : 'exception during the turn',
      stage: evidence.turns.length === 0 ? 'none' : stage,
      rootCause: { category: 'infra', detail: thrown },
      failures: [thrown],
    };
  }
  const failed = evidence.turns.find((t) => t.httpStatus >= 500);
  if (failed) {
    const detail = `HTTP ${failed.httpStatus} on turn ${failed.index} ("${failed.text}")`;
    return {
      verdict: 'FAIL',
      reason: detail,
      stage,
      rootCause: { category: 'infra', detail },
      failures: [detail],
    };
  }

  const failures = evaluateChatExpectations(expect, evidence, fixtureIds, options);
  if (failures.length === 0) {
    const proposal = evidence.proposals[0];
    return {
      verdict: 'PASS',
      reason: proposal ? `proposal:${proposal.proposalType}` : `${expect.outcome}:${stage}`,
      stage,
      rootCause: null,
      failures: [],
    };
  }

  const signals = deriveChatSignals(c, evidence);
  const rootCause = deriveChatRootCause(c, expect, failures, signals);
  const fellBack =
    signals.unrecognized ||
    signals.unhandledCapability ||
    signals.approvalRefused ||
    signals.degradedEnvelope ||
    signals.lookupFailedOrRefused ||
    signals.clarificationMinted;

  return {
    verdict: fellBack ? 'DEGRADED' : 'PARTIAL',
    reason: failures[0],
    stage,
    rootCause,
    failures,
  };
}
