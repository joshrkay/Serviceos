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
 * MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS-th back-to-back strike speaks the
 * VOX-35c escalation line and ends the session with
 * `low_stt_confidence_max_retries`; a good turn clears the streak. The copy
 * renders in the session's language.
 */
import { describe, it, expect } from 'vitest';
import {
  MIN_STT_CONFIDENCE,
  MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS,
  isLowSttConfidence,
  lowSttLadderStep,
  runLowSttConfidenceLadder,
  LOW_STT_LADDER_TERMINAL_REASON,
} from '../../../../src/ai/voice-turn/shared/low-stt-ladder';
import {
  renderTtsText,
  LOW_STT_CONFIDENCE_REPROMPT_COPY,
  SPEECH_TURN_FAILURE_ESCALATION_COPY,
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
  it('the floor is 0.5 by default and the ladder is two strikes long', () => {
    expect(MIN_STT_CONFIDENCE).toBe(0.5);
    expect(MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS).toBe(2);
    expect(LOW_STT_LADDER_TERMINAL_REASON).toBe('low_stt_confidence_max_retries');
  });

  it('a missing, non-finite, or at-or-above-floor confidence is HIGH — only a real number below the floor is low', () => {
    expect(isLowSttConfidence(undefined)).toBe(false);
    expect(isLowSttConfidence(Number.NaN)).toBe(false);
    expect(isLowSttConfidence(MIN_STT_CONFIDENCE)).toBe(false);
    expect(isLowSttConfidence(0.95)).toBe(false);
    expect(isLowSttConfidence(0.3)).toBe(true);
  });

  it('strike 1 reprompts; strike 2 escalates', () => {
    expect(lowSttLadderStep(1)).toEqual({
      escalate: false,
      copy: LOW_STT_CONFIDENCE_REPROMPT_COPY,
      errorKind: 'low_stt_confidence',
    });
    expect(lowSttLadderStep(2)).toEqual({
      escalate: true,
      copy: SPEECH_TURN_FAILURE_ESCALATION_COPY,
      errorKind: 'low_stt_confidence_repeated',
    });
  });

  it('keeps one streak per session: reprompt, then escalation + end_session, then a fresh first strike', () => {
    const streaks = new Map<string, number>();
    const s = session();

    const first = runLowSttConfidenceLadder(s, streaks);
    expect(first.escalated).toBe(false);
    expect(tts(first.effects)).toEqual([renderTtsText(LOW_STT_CONFIDENCE_REPROMPT_COPY, {}, 'en')]);
    expect(ends(first.effects)).toEqual([]);
    expect(streaks.get(s.id)).toBe(1);

    const second = runLowSttConfidenceLadder(s, streaks);
    expect(second.escalated).toBe(true);
    expect(tts(second.effects)).toEqual([renderTtsText(SPEECH_TURN_FAILURE_ESCALATION_COPY, {}, 'en')]);
    expect(ends(second.effects)).toEqual(['low_stt_confidence_max_retries']);
    expect(streaks.has(s.id)).toBe(false);

    expect(runLowSttConfidenceLadder(s, streaks).escalated).toBe(false);
  });

  it('speaks the ladder in Spanish on an es session', () => {
    const s = session('es');
    const fx = runLowSttConfidenceLadder(s, new Map()).effects;
    expect(tts(fx)).toEqual([renderTtsText(LOW_STT_CONFIDENCE_REPROMPT_COPY, {}, 'es')]);
    expect(tts(fx)[0]).not.toBe(renderTtsText(LOW_STT_CONFIDENCE_REPROMPT_COPY, {}, 'en'));
  });
});
