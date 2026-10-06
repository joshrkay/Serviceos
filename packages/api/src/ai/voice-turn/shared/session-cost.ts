/**
 * Model usage on the session cost tracker, and the ONE decision "this turn
 * ends the call for an exceeded cap".
 *
 * #1204 — decide on the tracker's LEVEL, not on this turn's events. The
 * tracker emits `cost_cap_exceeded` once per dimension, and the sentiment
 * classifier / vulnerability grader record their own usage on the same
 * tracker between turns and discard the events (`recordCompletionUsage`). A
 * classifier that crossed the cap therefore consumed the event, and no later
 * turn ever ended the call. `isExceeded` is set by the same recordUsage that
 * emits the event, so a turn whose own usage crosses the cap still ends the
 * call on that turn — and a session is ended ONCE (keyed by the live session
 * object, GC'd with it).
 *
 * #1601 step 2 — lifted verbatim from `create-voice-turn-processor.ts` so the
 * in-app adapter's confirm-step question path (which had drifted to the
 * event-based rule) decides the same way. One recorder per processor /
 * adapter instance; both phone transports share the processor's, so the
 * one-end-per-session guarantee holds across them.
 */
import type { VoiceSession } from '../../agents/customer-calling/voice-session-store';
import { estimateCostCents } from '../../skills/session-cost-tracker';
import { costIncurredEvent, sessionTerminatedEvent } from '../../voice-quality/events';

export type TurnTokenUsage = { input: number; output: number } | undefined;

export interface SessionCostRecorder {
  /** Record one turn's usage on the session tracker and emit cost_incurred. */
  recordTurnUsage(session: VoiceSession, usage: TurnTokenUsage): void;
  /**
   * Record the usage, then: true when the session's cap is exceeded and this
   * is the first turn to notice (the caller ends the call), else false.
   */
  recordCost(session: VoiceSession, usage: TurnTokenUsage): boolean;
}

export function createSessionCostRecorder(): SessionCostRecorder {
  const capEndedSessions = new WeakSet<VoiceSession>();

  const recordTurnUsage = (session: VoiceSession, usage: TurnTokenUsage): void => {
    if (!usage) return;
    const cents = estimateCostCents(usage.input, usage.output);
    session.costTracker.recordUsage({
      inputTokens: usage.input,
      outputTokens: usage.output,
      costCents: cents,
    });
    session.events.emit('voice-event', costIncurredEvent(cents, session.costTracker.totals.costCents));
  };

  const recordCost = (session: VoiceSession, usage: TurnTokenUsage): boolean => {
    recordTurnUsage(session, usage);
    if (!session.costTracker.isExceeded || capEndedSessions.has(session)) {
      return false;
    }
    capEndedSessions.add(session);
    session.events.emit('voice-event', sessionTerminatedEvent('cap_exceeded'));
    return true;
  };

  return { recordTurnUsage, recordCost };
}
