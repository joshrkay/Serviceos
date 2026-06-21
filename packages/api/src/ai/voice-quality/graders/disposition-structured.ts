/**
 * VQ-021 — Disposition-structured grader.
 *
 * Grades the mechanically-checkable parts of disposition correctness:
 *   - Criterion 9  (rightIntentClassified): expected.intent matches the
 *     `intent_classified` event's intentType for the same turn (string
 *     equality, case-insensitive).
 *   - Criterion 10 (hard slots only): the proposal payload's "hard" fields
 *     (IDs, ISO-8601 timestamps, money-in-cents, short enum-shaped strings)
 *     deep-equal the expected payload. Soft fields (notes, reason text,
 *     long descriptions) are intentionally NOT graded here — they are the
 *     LLM-judge's job (VQ-022).
 *   - Criterion 11 (rightEscalationBehavior): an `escalation_triggered`
 *     event was/wasn't emitted for the turn, matching `expected.escalates`.
 *
 * Per-turn correlation is positional: the i-th `intent_classified` event
 * pairs with the i-th script turn, the i-th `proposal_created` event pairs
 * the same way (proposals are looked up by id in `observation.proposals`).
 *
 * Escalation correlation is per-turn by event-log index: a turn is graded
 * as "escalated" iff an `escalation_triggered` event fired AFTER the
 * previous turn's `intent_classified` event AND AT-OR-BEFORE the current
 * turn's `intent_classified` event. (For turn 0 the lower bound is the
 * start of the call.) For the final turn, anything after the previous
 * turn's intent counts. Log index — not the `Date.now()` ms timestamp — is
 * the ordering key, because a sub-millisecond script ties timestamps and
 * would mis-attribute a late-turn escalation to the earlier turn. This
 * avoids retroactively marking earlier turns "escalated" when only a late
 * turn triggered escalation — the correct behavior for adversarial
 * multi-turn scripts where `expected.escalates` differs across turns.
 *
 * Hard/soft heuristic — v1, deliberately simple, will be tuned with usage:
 *   HARD if the key:
 *     - ends in `Id` or `_id`
 *     - is a known identifier name (tenantId, customerId, appointmentId, …)
 *     - has a value that parses as ISO 8601 (Date.parse → finite, contains 'T'
 *       or matches a YYYY-MM-DD shape)
 *     - contains the substring `Cents` (money is integer cents)
 *     - is a short string with no spaces and length < 32 (treated as enum)
 *   SOFT (skipped) if the key:
 *     - is one of: notes, reason, description, summary, transcript_excerpt
 *     - has length > 30 chars
 *     - contains 'text', 'message', or 'note'
 *   When both rules fire, SOFT wins (fail-safe: don't false-positive a slot
 *   the LLM-judge will look at anyway).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Observation } from '../observation';
import type { VoiceQualityScript } from '../schema';
import type { Proposal } from '../../../proposals/proposal';
import type { VoiceSessionEvent } from '../../agents/customer-calling/voice-session-store';
import { eventLogIndex } from './event-order';

type IntentClassifiedEvent = Extract<VoiceSessionEvent, { type: 'intent_classified' }>;
type EscalationTriggeredEvent = Extract<VoiceSessionEvent, { type: 'escalation_triggered' }>;
type ProposalCreatedEvent = Extract<VoiceSessionEvent, { type: 'proposal_created' }>;

export interface DispositionStructuredResult {
  passed: boolean;
  /** Subset of {9, 10, 11} that failed. Empty when `passed` is true. */
  failedCriteria: number[];
  /** Human-readable failure reasons keyed by criterion number. */
  reasons: Record<number, string>;
  perTurnDetail: Array<{
    turnIndex: number;
    expectedIntent?: string;
    actualIntent?: string;
    intentMatched: boolean;
    expectedSlots?: Record<string, unknown>;
    actualSlots?: Record<string, unknown>;
    /** Slot keys whose hard values diverge from expected/golden. */
    hardSlotMismatches: string[];
    expectedProposalType?: string;
    actualProposalType?: string;
    proposalTypeMatched: boolean;
    expectedEscalates?: boolean;
    actualEscalated: boolean;
    escalationMatched: boolean;
  }>;
}

/**
 * Read `<corpusRoot>/golden/<scriptId>.json` if it exists. Returns the
 * parsed array (one expected proposal payload per turn, in turn order)
 * or `undefined` when the file is absent — many scripts will not yet
 * have a golden file during corpus authoring.
 */
export function loadGoldenForScript(
  scriptId: string,
  corpusRoot?: string,
): Record<string, unknown>[] | undefined {
  if (!corpusRoot) return undefined;
  const file = path.join(corpusRoot, 'golden', `${scriptId}.json`);
  if (!fs.existsSync(file)) return undefined;
  const raw = fs.readFileSync(file, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `loadGoldenForScript: ${file} must contain a JSON array; got ${typeof parsed}`,
    );
  }
  return parsed as Record<string, unknown>[];
}

const SOFT_KEY_NAMES = new Set([
  'notes',
  'reason',
  'description',
  'summary',
  'transcript_excerpt',
]);

const SOFT_KEY_SUBSTRINGS = ['text', 'message', 'note'];

const KNOWN_ID_KEYS = new Set([
  'tenantId',
  'customerId',
  'appointmentId',
  'invoiceId',
  'estimateId',
  'jobId',
  'leadId',
  'proposalId',
  'userId',
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function isIso8601(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (!ISO_DATE_RE.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function looksLikeEnum(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length < 32 &&
    !/\s/.test(value)
  );
}

/**
 * Decide whether a slot key/value pair is a "hard" structural field.
 * Soft wins on tie — better to skip a borderline slot (the LLM-judge
 * will see it) than to false-positive a paraphrased note.
 */
export function isHardSlot(key: string, value: unknown): boolean {
  // Soft wins.
  if (SOFT_KEY_NAMES.has(key)) return false;
  const lowerKey = key.toLowerCase();
  for (const sub of SOFT_KEY_SUBSTRINGS) {
    if (lowerKey.includes(sub)) return false;
  }
  if (typeof value === 'string' && value.length > 30 && !isIso8601(value)) {
    return false;
  }

  // Hard signals.
  if (key.endsWith('Id') || key.endsWith('_id')) return true;
  if (KNOWN_ID_KEYS.has(key)) return true;
  if (key.includes('Cents')) return true;
  if (isIso8601(value)) return true;
  if (looksLikeEnum(value)) return true;

  // Numbers and booleans are structural by default.
  if (typeof value === 'number' || typeof value === 'boolean') return true;

  return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as Record<string, unknown>).sort();
    const bk = Object.keys(b as Record<string, unknown>).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
      if (ak[i] !== bk[i]) return false;
      if (
        !deepEqual(
          (a as Record<string, unknown>)[ak[i]],
          (b as Record<string, unknown>)[bk[i]],
        )
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * Compute the set of hard slot keys whose values differ between
 * `actual` and `expected`. A key is checked only if it appears in
 * `expected` AND the expected value is classified as hard. Missing
 * actual values count as a mismatch (the agent dropped the field).
 */
function diffHardSlots(
  expected: Record<string, unknown> | undefined,
  actual: Record<string, unknown> | undefined,
): string[] {
  if (!expected) return [];
  const mismatches: string[] = [];
  for (const key of Object.keys(expected)) {
    if (!isHardSlot(key, expected[key])) continue;
    const actualVal = actual?.[key];
    if (!deepEqual(expected[key], actualVal)) {
      mismatches.push(key);
    }
  }
  return mismatches;
}

function intentEvents(obs: Observation): IntentClassifiedEvent[] {
  return obs.events.filter(
    (e): e is IntentClassifiedEvent => e.type === 'intent_classified',
  );
}

function escalationEvents(obs: Observation): EscalationTriggeredEvent[] {
  return obs.events.filter(
    (e): e is EscalationTriggeredEvent => e.type === 'escalation_triggered',
  );
}

function proposalCreatedEvents(obs: Observation): ProposalCreatedEvent[] {
  return obs.events.filter(
    (e): e is ProposalCreatedEvent => e.type === 'proposal_created',
  );
}

/**
 * Grade criteria 9, 11, and the hard-slot subset of 10. Soft slots and
 * criterion 12 (caller-facing answer) are owned by VQ-022.
 *
 * `goldenProposals` overrides `script.turns[i].expected.slots` when
 * provided; pass `undefined` and we fall back to the script's expected
 * slots (matching authoring during corpus development).
 */
export function gradeDispositionStructured(
  observation: Observation,
  script: VoiceQualityScript,
  goldenProposals?: Record<string, unknown>[],
): DispositionStructuredResult {
  const intents = intentEvents(observation);
  const escalations = escalationEvents(observation);
  const proposalEvents = proposalCreatedEvents(observation);
  const proposalsById = new Map<string, Proposal>();
  for (const p of observation.proposals) proposalsById.set(p.id, p);

  // Attribute escalations to turns by causal log order, not `Date.now()`
  // timestamps — a sub-millisecond script ties a turn's intent_classified
  // with a later turn's escalation_triggered, mis-grading criterion 11.
  // See `eventLogIndex`.
  const logIndexAt = eventLogIndex(observation.events);
  // Escalation positions are turn-independent — derive them once.
  const escalationIndices = escalations.map(logIndexAt);

  const perTurnDetail: DispositionStructuredResult['perTurnDetail'] = [];
  const failedSet = new Set<number>();
  const reasons: Record<number, string> = {};

  for (let i = 0; i < script.turns.length; i++) {
    const turn = script.turns[i];
    const expected = turn.expected;
    const intentEv = intents[i];
    const propEv = proposalEvents[i];
    // Resolve actual proposal payload either by id (when emitted) or
    // by positional fallback against `observation.proposals`.
    const proposal =
      (propEv && proposalsById.get(propEv.proposalId)) ||
      observation.proposals[i];

    const actualIntent = intentEv?.intentType;
    const intentMatched =
      expected.intent === undefined
        ? true
        : actualIntent !== undefined &&
          expected.intent.toLowerCase() === actualIntent.toLowerCase();

    const expectedSlots =
      goldenProposals?.[i] ?? (expected.slots as Record<string, unknown> | undefined);
    const actualSlots = proposal?.payload as Record<string, unknown> | undefined;
    const hardSlotMismatches = diffHardSlots(expectedSlots, actualSlots);

    const expectedProposalType = expected.proposalType;
    const actualProposalType = proposal?.proposalType;
    const proposalTypeMatched =
      expectedProposalType === undefined
        ? true
        : expectedProposalType === actualProposalType;

    // Escalation correlation (per-turn): an escalation_triggered event is
    // attributed to turn i iff its log index falls within turn i's window
    // (see `logIndexOf` above for why log index, not timestamp). The lower
    // bound is the previous turn's intent_classified index (or -1 before
    // turn 0); the upper bound is turn i's intent_classified index EXCEPT
    // for the last turn, whose upper bound is +Inf so an escalation that
    // fires after the agent's last classification (but before
    // session_terminated) still lands on the final turn. A missing intent
    // on a non-last turn leaves the window un-anchored (upper = -1) so
    // nothing is attributed — a false positive would mis-grade.
    const lowerBound = i === 0 ? -1 : intents[i - 1] ? logIndexAt(intents[i - 1]) : -1;
    const isLastTurn = i === script.turns.length - 1;
    const upperBound = isLastTurn ? Infinity : intentEv ? logIndexAt(intentEv) : -1;
    const actualEscalated = escalationIndices.some(
      (k) => k > lowerBound && k <= upperBound,
    );
    const expectedEscalates = expected.escalates;
    const escalationMatched =
      expectedEscalates === undefined ? true : expectedEscalates === actualEscalated;

    if (!intentMatched) {
      failedSet.add(9);
      reasons[9] =
        reasons[9] ??
        `turn ${i}: expected intent '${expected.intent}', got '${actualIntent ?? '<none>'}'`;
    }

    if (hardSlotMismatches.length > 0 || !proposalTypeMatched) {
      failedSet.add(10);
      const parts: string[] = [];
      if (!proposalTypeMatched) {
        parts.push(
          `proposalType '${expectedProposalType}' vs '${actualProposalType ?? '<none>'}'`,
        );
      }
      if (hardSlotMismatches.length > 0) {
        parts.push(`hard-slot mismatches: ${hardSlotMismatches.join(', ')}`);
      }
      reasons[10] = reasons[10] ?? `turn ${i}: ${parts.join('; ')}`;
    }

    if (!escalationMatched) {
      failedSet.add(11);
      reasons[11] =
        reasons[11] ??
        `turn ${i}: expected escalates=${expectedEscalates}, got ${actualEscalated}`;
    }

    perTurnDetail.push({
      turnIndex: i,
      expectedIntent: expected.intent,
      actualIntent,
      intentMatched,
      expectedSlots,
      actualSlots,
      hardSlotMismatches,
      expectedProposalType,
      actualProposalType,
      proposalTypeMatched,
      expectedEscalates,
      actualEscalated,
      escalationMatched,
    });
  }

  const failedCriteria = [...failedSet].sort((a, b) => a - b);
  return {
    passed: failedCriteria.length === 0,
    failedCriteria,
    reasons,
    perTurnDetail,
  };
}
