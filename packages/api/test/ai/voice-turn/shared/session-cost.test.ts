/**
 * #1601 step 2 — recording a turn's model usage on the session cost tracker,
 * and deciding "this turn ends the call for an exceeded cap", has ONE home.
 *
 * The rule is #1204's: decide on the tracker's LEVEL, not on this turn's
 * events. The tracker emits `cost_cap_exceeded` once per dimension, and the
 * sentiment classifier / vulnerability grader record their own usage on the
 * same tracker between turns and discard the events — a classifier that
 * crossed the cap consumed the event, and (before #1204) no later turn ever
 * ended the call. `isExceeded` is set by the same recordUsage that emits the
 * event, so a turn whose own usage crosses the cap still ends the call on
 * that turn, and the call is ended ONCE per session.
 */
import { describe, it, expect } from 'vitest';
import { createSessionCostRecorder } from '../../../../src/ai/voice-turn/shared/session-cost';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { costIncurredEvent, sessionTerminatedEvent } from '../../../../src/ai/voice-quality/events';
import { estimateCostCents } from '../../../../src/ai/skills/session-cost-tracker';

const store = new VoiceSessionStore({ startInterval: false });
const HUGE = { input: 1_000_000, output: 1_000_000 };
const TINY = { input: 1, output: 1 };
const COST_INCURRED = costIncurredEvent(1, 1).type;
const SESSION_TERMINATED = sessionTerminatedEvent('cap_exceeded').type;

function session() {
  const s = store.create('t-1601-cost', 'telephony', { callSid: `CA-${Math.random().toString(36).slice(2, 8)}` });
  const events: Array<{ type: string; cause?: string }> = [];
  s.events.on('voice-event', (e: { type: string; cause?: string }) => events.push(e));
  return { s, events };
}

describe('createSessionCostRecorder (shared)', () => {
  it('recordTurnUsage adds the turn to the tracker and emits cost_incurred; no usage records nothing', () => {
    const { s, events } = session();
    const rec = createSessionCostRecorder();
    rec.recordTurnUsage(s, TINY);
    expect(s.costTracker.totals.costCents).toBe(estimateCostCents(1, 1));
    expect(events.map((e) => e.type)).toEqual([COST_INCURRED]);
    rec.recordTurnUsage(s, undefined);
    expect(events).toHaveLength(1);
  });

  it('recordCost: under the cap the call goes on; the turn that crosses it ends the call once', () => {
    const { s, events } = session();
    const rec = createSessionCostRecorder();
    expect(rec.recordCost(s, TINY)).toBe(false);
    expect(rec.recordCost(s, HUGE)).toBe(true);
    expect(events.filter((e) => e.type === SESSION_TERMINATED)).toEqual([
      expect.objectContaining({ type: SESSION_TERMINATED, cause: 'cap_exceeded' }),
    ]);
    // Already ended for the cap: a later turn never ends it a second time.
    expect(rec.recordCost(s, TINY)).toBe(false);
    expect(events.filter((e) => e.type === SESSION_TERMINATED)).toHaveLength(1);
  });

  it('#1204 — a cap crossed by a classifier that discarded the event still ends the call on the next recorded turn', () => {
    const { s, events } = session();
    const rec = createSessionCostRecorder();
    // The sentiment classifier's recordCompletionUsage shape: usage on the
    // tracker, events thrown away.
    s.costTracker.recordUsage({ inputTokens: HUGE.input, outputTokens: HUGE.output, costCents: estimateCostCents(HUGE.input, HUGE.output) });
    expect(s.costTracker.isExceeded).toBe(true);
    expect(rec.recordCost(s, TINY)).toBe(true);
    expect(events.filter((e) => e.type === SESSION_TERMINATED)).toHaveLength(1);
  });
});
