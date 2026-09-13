/**
 * R1 instrumentation — the per-turn ACTION-PATH trace.
 *
 * Every in-app operator voice turn answers exactly one question for whoever
 * is grading it: *how far did this turn actually get, and if it stopped
 * short, what stopped it?* Before this module that question could only be
 * answered by re-deriving the answer from side effects and audit event names
 * at the far end of an HTTP response — which is how a booking that never left
 * `intent_capture` could still be scored as "the API returned 200".
 *
 * `TurnTrace` is that answer, computed inside the adapter from what the turn
 * really did (the FSM event it dispatched, the entity-resolution outcome, the
 * side effects it executed, the proposal type it minted, the classifier
 * failure class it caught), returned on `HandleInputResult`, echoed on the
 * SSE `transition` event, and returned by `POST /api/voice/sessions/:id/input`.
 *
 * The stage vocabulary is the one the 50-case register scores against — see
 * `docs/plans/2026-09-09-inapp-50-cases-plan.md` § Harness → "Stage (furthest
 * reached)". `deriveTurnTrace` is PURE: it takes a description of the turn and
 * returns the trace, so the precedence rules below are unit-testable without
 * an adapter, a gateway, or a session.
 */

import { TAU_INT } from './transitions';

/**
 * The furthest point on the action path this turn reached.
 *
 * `none` means the turn advanced nothing (an unrecognised utterance below
 * τ_int, or a turn the harness could not observe at all). `guarded` means a
 * DELIBERATE deterministic stop: the #846 confirm-with-nothing-pending guard,
 * a refusal, a duplicate-turn replay, or a noise reprompt — a turn that was
 * handled correctly by design rather than one that fell through.
 */
export type TurnStage =
  | 'intent_detected'
  | 'entities_resolved'
  | 'clarification_asked'
  | 'confirmation_asked'
  | 'proposal_created'
  | 'committed'
  | 'answered'
  | 'escalated'
  | 'guarded'
  | 'none';

/**
 * Entity-resolution outcome for the turn. The first four mirror
 * `SchedulingEntityResolution['status']` one-for-one (entity-resolution.ts);
 * `skipped` means the turn classified an intent that needed no resolver pass
 * (an adapter act, a lookup, an intent with no free-text references).
 */
export type TurnResolution =
  | 'resolved'
  | 'ambiguous'
  | 'not_found'
  | 'low_confidence'
  | 'skipped';

/**
 * Why the turn stopped short of the action it was aiming at. `reprompt` and
 * `escalation` are the FSM's own budgeted fallbacks; `guard` is a deliberate
 * refusal-to-act by a deterministic guard; `clarification_card` is the degrade
 * every cluster fix in the 50-case plan exists to remove (an operator request
 * that became a `voice_clarification` nobody can act on).
 */
export type TurnFallbackReason =
  | 'reprompt'
  | 'escalation'
  | 'guard'
  | 'refusal'
  | 'clarification_card'
  | `classifier_failure:${string}`
  | 'lookup_unavailable'
  | 'lookup_refused';

/** Set when a deterministic recovery path handled the turn instead of the FSM. */
export type TurnDedup = 'duplicate_turn' | 'noise';

export interface TurnTrace {
  stage: TurnStage;
  intent?: string;
  confidence?: number;
  resolution?: TurnResolution;
  proposalType?: string;
  fallbackReason?: TurnFallbackReason;
  dedup?: TurnDedup;
}

export interface TurnTraceInput {
  /** FSM state AFTER the turn (`session.machine.currentState`). */
  finalState: string;
  /** The FSM event this turn dispatched, when it dispatched one. */
  eventType?: string;
  /** Classifier intent for this turn, when the classifier ran. */
  intent?: string;
  /** Classifier confidence for this turn, when the classifier ran. */
  confidence?: number;
  /** Entity-resolution outcome, when a resolver pass ran. */
  resolution?: TurnResolution;
  /** True when THIS turn minted a proposal (not merely that the session has one). */
  proposalMinted?: boolean;
  /** The minted proposal's type, when one was minted. */
  proposalType?: string;
  /** True when the turn spoke a read-only lookup answer instead of acting. */
  answered?: boolean;
  /** Set by the deterministic duplicate-turn / noise recovery paths. */
  dedup?: TurnDedup;
  /** Classifier failure class (`parse_failed` | `deadline` | `quota` | …). */
  classifierFailureClass?: string;
  /** True when the turn was an explicit capability refusal (voice approval). */
  refused?: boolean;
  /** True when a lookup could not run because its dependency bundle is absent. */
  lookupUnavailable?: boolean;
  /** True when a lookup was refused by RBAC (fails closed). */
  lookupRefused?: boolean;
  /** `SideEffect.type` for every side effect executed this turn. */
  sideEffectTypes?: readonly string[];
  /** `payload.eventType` for every `audit_log` side effect executed this turn. */
  auditEventTypes?: readonly string[];
}

/**
 * Dedup key for an operator turn: trim, lowercase, collapse internal
 * whitespace, strip trailing punctuation. Deliberately conservative — it
 * normalises the ways a client retry / double tap / STT echo re-sends the
 * SAME sentence, and nothing else. Two different requests never collide.
 */
export function normalizeTurnText(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;:\s]+$/g, '')
    .trim();
}

function endsWithSuffix(values: readonly string[], suffix: string): boolean {
  return values.some((value) => value.endsWith(suffix));
}

/**
 * Fallback precedence, most specific first. An explicit refusal names itself;
 * a classifier failure is reported ahead of whatever the FSM did about it
 * (the failure is the root cause, the escalation/reprompt is the symptom);
 * the generic reprompt is last so it never masks a sharper reason.
 */
function deriveFallbackReason(input: TurnTraceInput): TurnFallbackReason | undefined {
  const sideEffectTypes = input.sideEffectTypes ?? [];
  const auditEventTypes = input.auditEventTypes ?? [];

  if (input.refused) return 'refusal';
  if (input.lookupRefused) return 'lookup_refused';
  if (input.lookupUnavailable) return 'lookup_unavailable';
  if (input.classifierFailureClass) {
    return `classifier_failure:${input.classifierFailureClass}`;
  }
  if (
    input.finalState === 'escalating' ||
    sideEffectTypes.includes('notify_oncall') ||
    sideEffectTypes.includes('escalate_with_context')
  ) {
    return 'escalation';
  }
  if (endsWithSuffix(auditEventTypes, 'confirm_without_pending')) return 'guard';
  if (input.proposalType === 'voice_clarification') return 'clarification_card';
  if (input.dedup === 'noise') return 'reprompt';
  if (endsWithSuffix(auditEventTypes, '.reprompt')) return 'reprompt';
  return undefined;
}

/**
 * Stage precedence, furthest-along first. A turn that minted AND queued a
 * proposal is `committed` even though it also asked a confirmation earlier in
 * the session; a turn that only asked the readback is `confirmation_asked`.
 *
 * `entity_confirm` traces as `clarification_asked`, not `confirmation_asked`:
 * it is the resolver asking "did you mean this one?", which the register's
 * stage table groups with `entity_ambiguous`. `intent_confirm` — the mutation
 * readback that gates every proposal — is the one that means `confirmation_asked`.
 */
function deriveStage(input: TurnTraceInput): TurnStage {
  const sideEffectTypes = input.sideEffectTypes ?? [];
  const auditEventTypes = input.auditEventTypes ?? [];

  // A deterministic recovery path handled the turn: nothing advanced, and
  // nothing was supposed to. `dedup` says which path; the stage says the turn
  // was handled by design rather than dropped on the floor.
  if (input.dedup) return 'guarded';

  if (input.proposalMinted) {
    return input.finalState === 'closing' || endsWithSuffix(auditEventTypes, 'proposal_queued')
      ? 'committed'
      : 'proposal_created';
  }
  if (input.answered) return 'answered';
  if (
    input.finalState === 'escalating' ||
    sideEffectTypes.includes('notify_oncall') ||
    sideEffectTypes.includes('escalate_with_context')
  ) {
    return 'escalated';
  }
  if (
    input.refused ||
    input.lookupRefused ||
    input.lookupUnavailable ||
    endsWithSuffix(auditEventTypes, 'confirm_without_pending')
  ) {
    return 'guarded';
  }
  if (
    input.finalState === 'entity_resolution' ||
    input.finalState === 'entity_confirm' ||
    input.resolution === 'ambiguous' ||
    input.resolution === 'low_confidence' ||
    endsWithSuffix(auditEventTypes, 'entity_ambiguous') ||
    endsWithSuffix(auditEventTypes, 'entity_confirm_candidate')
  ) {
    return 'clarification_asked';
  }
  if (input.finalState === 'intent_confirm') return 'confirmation_asked';
  if (input.resolution === 'resolved') return 'entities_resolved';
  if (
    input.intent !== undefined &&
    input.intent !== 'unknown' &&
    (input.confidence ?? 0) >= TAU_INT
  ) {
    return 'intent_detected';
  }
  return 'none';
}

/**
 * Build the trace for one turn. Pure — every input is a plain description of
 * what the turn did, so the precedence rules can be pinned without a session.
 */
export function deriveTurnTrace(input: TurnTraceInput): TurnTrace {
  const trace: TurnTrace = { stage: deriveStage(input) };
  if (input.intent !== undefined) trace.intent = input.intent;
  if (typeof input.confidence === 'number') trace.confidence = input.confidence;
  if (input.resolution !== undefined) trace.resolution = input.resolution;
  if (input.proposalType !== undefined) trace.proposalType = input.proposalType;
  const fallbackReason = deriveFallbackReason(input);
  if (fallbackReason !== undefined) trace.fallbackReason = fallbackReason;
  if (input.dedup !== undefined) trace.dedup = input.dedup;
  return trace;
}
