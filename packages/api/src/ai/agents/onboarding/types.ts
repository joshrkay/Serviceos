/**
 * Onboarding Agent — types for the conversational FSM.
 *
 * Channel-agnostic: the FSM is a pure reducer. All I/O (gateway calls,
 * persistence, audit emission) happens in the orchestrator after a
 * `dispatch()` returns the side-effect list.
 */

import type {
  BusinessProfileExtraction,
  ServiceCategoryExtraction,
  PricingExtraction,
  TeamMemberExtraction,
  ScheduleExtraction,
  OnboardingExtraction,
} from '../../tasks/onboarding/types';

// ─── States ──────────────────────────────────────────────────────────────────

/**
 * Linear extraction pipeline; states roughly map to the existing
 * extractors plus a confirmation step and two terminals.
 */
export type OnboardingState =
  | 'profile_capture'
  | 'category_capture'
  | 'pricing_capture'
  | 'team_capture'
  | 'schedule_capture'
  | 'review'
  | 'completed'
  | 'capped';

/** Mid-stream states the extractor pipeline maps over. */
export type ExtractionState = Exclude<OnboardingState, 'review' | 'completed' | 'capped'>;

// ─── Transcript turn ─────────────────────────────────────────────────────────

export interface TranscriptTurn {
  role: 'user' | 'assistant';
  text: string;
  /** UTC ISO timestamp. */
  at: string;
  /** Which FSM state was active when this turn was recorded. */
  state: OnboardingState;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export type ExtractionResultPayload =
  | { state: 'profile_capture'; data: BusinessProfileExtraction; confidence: number; needsClarification: boolean; clarificationQuestions: string[] }
  | { state: 'category_capture'; data: ServiceCategoryExtraction; confidence: number; needsClarification: boolean; clarificationQuestions: string[] }
  | { state: 'pricing_capture'; data: PricingExtraction; confidence: number; needsClarification: boolean; clarificationQuestions: string[] }
  | { state: 'team_capture'; data: TeamMemberExtraction; confidence: number; needsClarification: boolean; clarificationQuestions: string[] }
  | { state: 'schedule_capture'; data: ScheduleExtraction; confidence: number; needsClarification: boolean; clarificationQuestions: string[] };

export type OnboardingEvent =
  /** A user utterance arrived. The orchestrator hands it to the FSM,
   *  which appends it to the transcript and decides whether to call
   *  an extractor or short-circuit to a clarification reprompt. */
  | { kind: 'user_turn'; utterance: string; now: string }
  /** An extractor side-effect completed; FSM decides whether the
   *  confidence is high enough to advance or whether to reprompt. */
  | { kind: 'extraction_result'; result: ExtractionResultPayload }
  /** Extractor errored or returned malformed output. FSM falls through
   *  to a recovery clarification (does not consume an extractor call). */
  | { kind: 'extraction_failed'; state: ExtractionState; reason: string }
  /** User confirmed the review summary; FSM transitions to `completed`. */
  | { kind: 'review_confirmed' };

// ─── Side effects (returned as data) ─────────────────────────────────────────

export type SideEffect =
  /** Call the extractor for `state` with the current transcript + prior
   *  extractions. The orchestrator runs this through the LLM gateway. */
  | { kind: 'call_extractor'; state: ExtractionState; transcript: string; previousExtractions: Partial<OnboardingExtraction> }
  /** Speak (or display) text as the assistant. */
  | { kind: 'emit_assistant_message'; text: string }
  /** Persist a typed audit event for the just-completed FSM step. */
  | { kind: 'audit_log'; eventType: string; metadata: Record<string, unknown> }
  /** FSM has reached `completed` or `capped` — the orchestrator should
   *  emit the existing `onboarding_*` proposal batches. */
  | { kind: 'emit_proposal_batches'; reason: 'completed' | 'capped' };

// ─── Context ─────────────────────────────────────────────────────────────────

export interface OnboardingContext {
  tenantId: string;
  sessionId: string;
  /** Conversation history. Appended on every user_turn and
   *  emit_assistant_message side-effect (the orchestrator does the
   *  latter; the FSM only tracks user turns in turn_count). */
  transcript: TranscriptTurn[];
  /** Accumulating extractor outputs, fed to subsequent extractor calls
   *  as `previousExtractions`. */
  extractions: Partial<OnboardingExtraction>;
  /** Per-state count of clarification reprompts. Bounded by
   *  MAX_CLARIFICATIONS_PER_STATE; on overflow the FSM force-advances. */
  clarificationCountByState: Partial<Record<ExtractionState, number>>;
  /** Total user turns dispatched. Bounded by MAX_TURNS; on overflow
   *  the FSM transitions to `capped`. */
  turnCount: number;
  /** Most recent set of clarifying questions the FSM asked. Surfaced
   *  to the orchestrator + persisted on the session. */
  pendingClarifications: string[];
}

// ─── Transition result ───────────────────────────────────────────────────────

export interface TransitionResult {
  nextState: OnboardingState;
  updatedContext: OnboardingContext;
  sideEffects: SideEffect[];
}
