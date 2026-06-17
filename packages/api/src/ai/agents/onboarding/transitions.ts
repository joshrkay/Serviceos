/**
 * Onboarding Agent — pure transition table.
 *
 * `transition(state, event, context) → { nextState, updatedContext, sideEffects[] }`.
 * No I/O. Side effects (extractor calls, gateway calls, persistence,
 * proposal emission) are returned as data; the orchestrator executes
 * them and dispatches follow-on events.
 *
 * Mirrors the customer-calling FSM pattern at
 * `packages/api/src/ai/agents/customer-calling/transitions.ts`.
 */

import {
  MAX_TURNS,
  MIN_EXTRACTION_CONFIDENCE,
  MAX_CLARIFICATIONS_PER_STATE,
} from './constants';
import type {
  OnboardingState,
  ExtractionState,
  OnboardingEvent,
  OnboardingContext,
  TransitionResult,
  SideEffect,
} from './types';

// ─── State prompts ───────────────────────────────────────────────────────────

/**
 * What the assistant says when first entering each state. The PRD demo
 * positions the onboarding agent as a conversational sweep — these are
 * the opening prompts; clarifications layered on top of them come from
 * the extractor's `clarificationQuestions`.
 */
const STATE_OPENING_PROMPT: Record<ExtractionState, string> = {
  profile_capture:
    "Hi! I'm going to set up your account. To start — tell me a bit about your business: name, where you're based, and what kind of work you do.",
  category_capture:
    'Got it. What kinds of services do you offer? Repairs, installs, maintenance, emergency work, that sort of thing.',
  pricing_capture:
    "Now let's talk pricing. What's your service-call or trip fee, your hourly rate, and any common flat-rate jobs?",
  team_capture:
    "Who's on your team? Just names and roles (technician, dispatcher, owner) — I'll add accounts for them.",
  schedule_capture:
    'Last one — what are your business hours, and do you cover after-hours emergency calls?',
};

/** Spoken at the start of `review`. */
const REVIEW_PROMPT =
  "All right, I've got enough to draft your setup. I'll send a few items to your inbox for you to review and approve. Say 'looks good' when you're ready, or tell me what to change.";

/** Spoken when the FSM transitions to `completed`. */
const COMPLETED_PROMPT =
  "Done. Your setup proposals are in the inbox — review and tap approve when you're ready.";

/** Spoken when the FSM transitions to `capped`. */
const CAPPED_PROMPT =
  "I've put together what I could from what we covered. Your inbox has the partial setup; you can edit any item before approving.";

// ─── Order ──────────────────────────────────────────────────────────────────

const EXTRACTION_ORDER: ExtractionState[] = [
  'profile_capture',
  'category_capture',
  'pricing_capture',
  'team_capture',
  'schedule_capture',
];

function nextExtractionState(state: ExtractionState): ExtractionState | 'review' {
  const i = EXTRACTION_ORDER.indexOf(state);
  return i === EXTRACTION_ORDER.length - 1 ? 'review' : EXTRACTION_ORDER[i + 1];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function joinTranscript(ctx: OnboardingContext): string {
  return ctx.transcript
    .map((t) => `${t.role === 'user' ? 'Owner' : 'Assistant'}: ${t.text}`)
    .join('\n');
}

function audit(eventType: string, metadata: Record<string, unknown>): SideEffect {
  return { kind: 'audit_log', eventType: `agent.onboarding.${eventType}`, metadata };
}

function emit(text: string): SideEffect {
  return { kind: 'emit_assistant_message', text };
}

function clarificationCount(ctx: OnboardingContext, state: ExtractionState): number {
  return ctx.clarificationCountByState[state] ?? 0;
}

function bumpClarification(
  ctx: OnboardingContext,
  state: ExtractionState,
): Partial<Record<ExtractionState, number>> {
  return {
    ...ctx.clarificationCountByState,
    [state]: clarificationCount(ctx, state) + 1,
  };
}

function appendUserTurn(
  ctx: OnboardingContext,
  state: OnboardingState,
  text: string,
  at: string,
): OnboardingContext {
  return {
    ...ctx,
    transcript: [...ctx.transcript, { role: 'user', text, at, state }],
    turnCount: ctx.turnCount + 1,
  };
}

// ─── Transition ─────────────────────────────────────────────────────────────

/**
 * `transition` is the FSM's sole entry point. Pure: same input → same
 * output. The orchestrator wraps it with persistence + extractor side-
 * effect execution.
 */
export function transition(
  state: OnboardingState,
  event: OnboardingEvent,
  context: OnboardingContext,
): TransitionResult {
  // Terminal states ignore further events.
  if (state === 'completed' || state === 'capped') {
    return { nextState: state, updatedContext: context, sideEffects: [] };
  }

  // ── user_turn ────────────────────────────────────────────────────────────
  if (event.kind === 'user_turn') {
    const ctx = appendUserTurn(context, state, event.utterance, event.now);

    // Cap reached? Force-advance to capped + emit whatever we have so far.
    if (ctx.turnCount >= MAX_TURNS && state !== 'review') {
      return {
        nextState: 'capped',
        updatedContext: ctx,
        sideEffects: [
          emit(CAPPED_PROMPT),
          { kind: 'emit_proposal_batches', reason: 'capped' },
          audit('cap_reached', { fromState: state, turnCount: ctx.turnCount }),
        ],
      };
    }

    // `review` accepts a confirmation utterance OR a correction. For
    // the MVP we treat any utterance here as confirmation — owners who
    // want to edit do so on the proposal cards. (Open Question #2 in
    // the plan; deliberately simple to keep U1 shippable.)
    if (state === 'review') {
      return {
        nextState: 'completed',
        updatedContext: ctx,
        sideEffects: [
          emit(COMPLETED_PROMPT),
          { kind: 'emit_proposal_batches', reason: 'completed' },
          audit('review_confirmed', { turnCount: ctx.turnCount }),
        ],
      };
    }

    // Otherwise we're in an extraction state — hand off to the extractor.
    return {
      nextState: state,
      updatedContext: ctx,
      sideEffects: [
        {
          kind: 'call_extractor',
          state,
          transcript: joinTranscript(ctx),
          previousExtractions: ctx.extractions,
        },
        audit('extractor_called', { state, turnCount: ctx.turnCount }),
      ],
    };
  }

  // ── extraction_failed ────────────────────────────────────────────────────
  if (event.kind === 'extraction_failed') {
    // Mirror customer-calling: a malformed gateway return falls through
    // to a clarification reprompt and does NOT advance state.
    const ctx: OnboardingContext = {
      ...context,
      clarificationCountByState: bumpClarification(context, event.state),
      pendingClarifications: ['Sorry, can you tell me that again in a different way?'],
    };
    return {
      nextState: state,
      updatedContext: ctx,
      sideEffects: [
        emit(ctx.pendingClarifications[0]),
        audit('extraction_failed', { state: event.state, reason: event.reason }),
      ],
    };
  }

  // ── extraction_result ────────────────────────────────────────────────────
  if (event.kind === 'extraction_result') {
    const extractedState = event.result.state;
    if (state !== extractedState) {
      // Late result for an out-of-state extractor; ignore.
      return {
        nextState: state,
        updatedContext: context,
        sideEffects: [
          audit('extraction_result_ignored', {
            currentState: state,
            resultState: extractedState,
          }),
        ],
      };
    }

    const newExtractions: typeof context.extractions = { ...context.extractions };
    switch (event.result.state) {
      case 'profile_capture':
        newExtractions.businessProfile = event.result.data;
        break;
      case 'category_capture':
        newExtractions.categories = event.result.data;
        break;
      case 'pricing_capture':
        newExtractions.pricing = event.result.data;
        break;
      case 'team_capture':
        newExtractions.team = event.result.data;
        break;
      case 'schedule_capture':
        newExtractions.schedule = event.result.data;
        break;
    }

    const confident =
      !event.result.needsClarification && event.result.confidence >= MIN_EXTRACTION_CONFIDENCE;
    const forcedAdvance =
      !confident && clarificationCount(context, extractedState) >= MAX_CLARIFICATIONS_PER_STATE;

    // Advance (confident OR forced) — move to next state.
    if (confident || forcedAdvance) {
      const advanceTo = nextExtractionState(extractedState);
      const updatedCtx: OnboardingContext = {
        ...context,
        extractions: newExtractions,
        pendingClarifications: [],
      };
      if (advanceTo === 'review') {
        return {
          nextState: 'review',
          updatedContext: updatedCtx,
          sideEffects: [
            emit(REVIEW_PROMPT),
            audit('advanced_to_review', {
              fromState: extractedState,
              forced: forcedAdvance,
            }),
          ],
        };
      }
      return {
        nextState: advanceTo,
        updatedContext: updatedCtx,
        sideEffects: [
          emit(STATE_OPENING_PROMPT[advanceTo]),
          audit('advanced', {
            fromState: extractedState,
            toState: advanceTo,
            forced: forcedAdvance,
          }),
        ],
      };
    }

    // Low confidence — reprompt for clarification.
    const questions =
      event.result.clarificationQuestions.length > 0
        ? event.result.clarificationQuestions
        : ['Could you tell me a little more about that?'];
    const updatedCtx: OnboardingContext = {
      ...context,
      extractions: newExtractions,
      clarificationCountByState: bumpClarification(context, extractedState),
      pendingClarifications: questions,
    };
    return {
      nextState: state,
      updatedContext: updatedCtx,
      sideEffects: [
        emit(questions[0]),
        audit('clarification_requested', {
          state: extractedState,
          count: clarificationCount(updatedCtx, extractedState),
        }),
      ],
    };
  }

  // ── review_confirmed ─────────────────────────────────────────────────────
  if (event.kind === 'review_confirmed' && state === 'review') {
    return {
      nextState: 'completed',
      updatedContext: context,
      sideEffects: [
        emit(COMPLETED_PROMPT),
        { kind: 'emit_proposal_batches', reason: 'completed' },
        audit('review_confirmed', { turnCount: context.turnCount }),
      ],
    };
  }

  // Anything else: no-op.
  return { nextState: state, updatedContext: context, sideEffects: [] };
}

// Exported solely so the orchestrator + tests can emit identical opening
// copy without re-duplicating the strings.
export { STATE_OPENING_PROMPT, REVIEW_PROMPT, COMPLETED_PROMPT, CAPPED_PROMPT };
