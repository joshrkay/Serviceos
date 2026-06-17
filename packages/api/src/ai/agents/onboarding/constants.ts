/**
 * Onboarding Agent — thresholds for the conversational FSM.
 *
 * Mirrored from the customer-calling agent's pattern of exporting
 * thresholds rather than hardcoding them inside the reducer, so tests
 * and adapters share the same numbers as the FSM.
 */

/**
 * Hard cap on user turns per onboarding session. PRD §6.3 cites the
 * "10–15 exchange" framing; we cap at 15 so a stuck conversation (silent
 * caller, broken extractor, owner who keeps rambling) doesn't blow the
 * gateway budget. On overflow the FSM transitions to `capped` and emits
 * whatever proposals current extraction context supports.
 */
export const MAX_TURNS = 15;

/**
 * Per-state floor for an extractor's confidence to be treated as
 * "extraction good enough to advance." Below this we emit a clarification
 * and stay in the same state (up to `MAX_CLARIFICATIONS_PER_STATE`).
 */
export const MIN_EXTRACTION_CONFIDENCE = 0.7;

/**
 * Max clarifying questions per state before forced advance. Prevents
 * the FSM from looping forever on a state whose extractor keeps coming
 * back low-confidence (e.g. a quiet caller). On forced advance the
 * resulting extraction is still emitted as a proposal, but flagged
 * so the owner can edit before approval.
 */
export const MAX_CLARIFICATIONS_PER_STATE = 2;
