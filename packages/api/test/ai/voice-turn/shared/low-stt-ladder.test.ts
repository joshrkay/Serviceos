/**
 * #1601 step 2 — the bounded reprompt→escalate ladder for a turn the
 * transport could not hear (empty utterance, or acoustic confidence below
 * the floor) has ONE home.
 *
 * Three copies carried the same rules (Gather `runLowSttConfidenceGatherLadder`,
 * the processor's `runLowSttConfidenceLadder`, media-streams
 * `recoverFromLowSttConfidence`): a missing / non-finite / at-or-above-floor
 * confidence is HIGH (never blocks a turn); below it, the first strike
 * reprompts with the "didn't catch that" line and the
 * MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS-th back-to-back strike ends the ladder
 * by the CAPPING strike's cause (LCR-02): low confidence dispatches the FSM's
 * `system_failure` (`low_stt_confidence_max_retries`, which pages on-call);
 * silence closes with a call-us-back line and `silence_max_retries`, paging
 * nobody. A good turn clears the streak. The copy renders in the session's
 * language.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MIN_STT_CONFIDENCE,
  MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS,
  isLowSttConfidence,
  lowSttLadderStep,
  runLowSttConfidenceLadder,
  createLowSttStreak,
  clearLowSttStreak,
  LOW_STT_LADDER_TERMINAL_REASON,
  SILENCE_LADDER_TERMINAL_REASON,
  parkedHandoffKind,
  noHandoffCloseEffects,
} from '../../../../src/ai/voice-turn/shared/low-stt-ladder';
import {
  renderTtsText,
  LOW_STT_CONFIDENCE_REPROMPT_COPY,
  SPEECH_TURN_FAILURE_ESCALATION_COPY,
  HANDOFF_UNAVAILABLE_COPY,
  SILENCE_CLOSING_COPY,
} from '../../../../src/ai/agents/customer-calling/tts-copy';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import type { SideEffect } from '../../../../src/ai/agents/customer-calling/types';

const store = new VoiceSessionStore({ startInterval: false });
const session = (language?: 'en' | 'es') => {
  const s = store.create('t-1601-ladder', 'telephony', { callSid: `CA-${Math.random().toString(36).slice(2, 8)}` });
  if (language) s.language = language;
  return s;
};
const tts = (fx: SideEffect[]) =>
  fx.filter((f) => f.type === 'tts_play').map((f) => String((f.payload as { text?: string }).text));
const ends = (fx: SideEffect[]) =>
  fx.filter((f) => f.type === 'end_session').map((f) => String((f.payload as { reason?: string }).reason));

describe('low-STT ladder (shared)', () => {
  const ORIGINAL_FLOOR = process.env.VOICE_MIN_STT_CONFIDENCE;
  afterEach(() => {
    if (ORIGINAL_FLOOR === undefined) delete process.env.VOICE_MIN_STT_CONFIDENCE;
    else process.env.VOICE_MIN_STT_CONFIDENCE = ORIGINAL_FLOOR;
    vi.resetModules();
  });

  it('the floor is 0.5 by default (VOICE_MIN_STT_CONFIDENCE unset) and the ladder is two strikes long', async () => {
    delete process.env.VOICE_MIN_STT_CONFIDENCE;
    vi.resetModules();
    const fresh = await import('../../../../src/ai/voice-turn/shared/low-stt-ladder');
    expect(fresh.MIN_STT_CONFIDENCE).toBe(0.5);
    expect(fresh.MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS).toBe(2);
    expect(fresh.LOW_STT_LADDER_TERMINAL_REASON).toBe('low_stt_confidence_max_retries');
    expect(SILENCE_LADDER_TERMINAL_REASON).toBe('silence_max_retries');
    expect(MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS).toBe(2);
  });

  it('VOICE_MIN_STT_CONFIDENCE overrides the floor; an out-of-range value falls back to the default', async () => {
    process.env.VOICE_MIN_STT_CONFIDENCE = '0.7';
    vi.resetModules();
    expect((await import('../../../../src/ai/voice-turn/shared/low-stt-ladder')).MIN_STT_CONFIDENCE).toBe(0.7);
    process.env.VOICE_MIN_STT_CONFIDENCE = '7';
    vi.resetModules();
    expect((await import('../../../../src/ai/voice-turn/shared/low-stt-ladder')).MIN_STT_CONFIDENCE).toBe(0.5);
  });

  it('a missing, non-finite, or at-or-above-floor confidence is HIGH — only a real number below the floor is low', () => {
    expect(isLowSttConfidence(undefined)).toBe(false);
    expect(isLowSttConfidence(Number.NaN)).toBe(false);
    expect(isLowSttConfidence(MIN_STT_CONFIDENCE)).toBe(false);
    expect(isLowSttConfidence(0.95)).toBe(false);
    expect(isLowSttConfidence(0.3)).toBe(true);
  });

  it('strike 1 reprompts whatever the cause; strike 2 ends by the capping strike\'s cause', () => {
    const reprompt = { kind: 'reprompt', copy: LOW_STT_CONFIDENCE_REPROMPT_COPY, errorKind: 'low_stt_confidence' };
    expect(lowSttLadderStep(1, 'silence')).toEqual(reprompt);
    expect(lowSttLadderStep(1, 'low_confidence')).toEqual(reprompt);
    expect(lowSttLadderStep(2, 'low_confidence')).toEqual({
      kind: 'system_failure',
      reason: 'low_stt_confidence_max_retries',
      errorKind: 'low_stt_confidence_repeated',
    });
    expect(lowSttLadderStep(2, 'silence')).toEqual({
      kind: 'silence_close',
      copy: SILENCE_CLOSING_COPY,
      reason: 'silence_max_retries',
      errorKind: 'low_stt_confidence_repeated',
    });
  });

  it('a low-confidence cap dispatches the FSM system_failure: notify_oncall is emitted, the session escalates', () => {
    const streak = createLowSttStreak();
    const s = session();
    s.machine.dispatch({ type: 'incoming_call', tenantId: 't-1601-ladder', callSid: s.callSid!, from: '+15125550100', to: '+15125550999' });

    const first = runLowSttConfidenceLadder(s, streak, 'silence');
    expect(first.step.kind).toBe('reprompt');
    expect(tts(first.effects)).toEqual([renderTtsText(LOW_STT_CONFIDENCE_REPROMPT_COPY, {}, 'en')]);
    expect(streak.get(s)).toBe(1);

    const second = runLowSttConfidenceLadder(s, streak, 'low_confidence');
    expect(second.step.kind).toBe('system_failure');
    expect(second.effects.some((f) => f.type === 'notify_oncall')).toBe(true);
    expect(s.machine.currentState).toBe('escalating');
    expect(s.machine.currentContext.escalationReason).toBe('system_failure:low_stt_confidence_max_retries');
    expect(streak.has(s)).toBe(false);
  });

  it('a silence cap pages nobody: the call-us-back line + end_session, the FSM untouched', () => {
    const streak = createLowSttStreak();
    const s = session();
    runLowSttConfidenceLadder(s, streak, 'low_confidence');
    const before = s.machine.currentState;

    const second = runLowSttConfidenceLadder(s, streak, 'silence');

    expect(second.step.kind).toBe('silence_close');
    expect(tts(second.effects)).toEqual([renderTtsText(SILENCE_CLOSING_COPY, {}, 'en')]);
    expect(ends(second.effects)).toEqual(['silence_max_retries']);
    expect(second.effects.some((f) => f.type === 'notify_oncall')).toBe(false);
    expect(tts(second.effects)).not.toContain(renderTtsText(SPEECH_TURN_FAILURE_ESCALATION_COPY, {}, 'en'));
    expect(s.machine.currentState).toBe(before);
    expect(runLowSttConfidenceLadder(s, streak, 'silence').step.kind).toBe('reprompt');
  });

  it('a good turn clears the streak, and sessions never share one', () => {
    const streak = createLowSttStreak();
    const a = session();
    const b = session();
    runLowSttConfidenceLadder(a, streak, 'silence');
    clearLowSttStreak(streak, a);
    expect(runLowSttConfidenceLadder(a, streak, 'silence').step.kind).toBe('reprompt');
    expect(runLowSttConfidenceLadder(b, streak, 'silence').step.kind).toBe('reprompt');
  });

  it('parkedHandoffKind tells a transfer from the no-one-available message from nothing', () => {
    expect(parkedHandoffKind('<Response><Dial timeout="20"><Number>+1</Number></Dial></Response>')).toBe('dial');
    expect(parkedHandoffKind('<Response><Dial>+15125550101</Dial></Response>')).toBe('dial');
    expect(parkedHandoffKind('<Response><Say>no one is available</Say><Hangup/></Response>')).toBe('message');
    expect(parkedHandoffKind(undefined)).toBe('none');
    expect(parkedHandoffKind('')).toBe('none');
  });

  it('noHandoffCloseEffects says nobody could be reached (in the call language) and ends', () => {
    const es = session('es');
    expect(noHandoffCloseEffects(es, 'low_stt_confidence_max_retries')).toEqual([
      { type: 'tts_play', payload: { text: renderTtsText(HANDOFF_UNAVAILABLE_COPY, {}, 'es') } },
      { type: 'end_session', payload: { reason: 'low_stt_confidence_max_retries' } },
    ]);
  });

  it('speaks the ladder in Spanish on an es session', () => {
    const s = session('es');
    const fx = runLowSttConfidenceLadder(s, createLowSttStreak(), 'silence').effects;
    expect(tts(fx)).toEqual([renderTtsText(LOW_STT_CONFIDENCE_REPROMPT_COPY, {}, 'es')]);
    expect(tts(fx)[0]).not.toBe(renderTtsText(LOW_STT_CONFIDENCE_REPROMPT_COPY, {}, 'en'));
  });
});
