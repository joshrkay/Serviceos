/**
 * #1601 step 2 — U5, the absolute per-call duration cap, has ONE home for
 * its numbers and its shape.
 *
 * Gather enforces it per webhook turn (session age vs the limit); media
 * streams arms timers. Both transports must cut at the same wall-clock
 * limit (15 minutes unless `VOICE_MAX_CALL_DURATION_MS` overrides it), warn
 * 30 s before it when the limit is long enough to fit the warning, speak the
 * same wrap-up line in the session's language and end the session with
 * terminal reason `max_call_duration` — never the generic `failed`, because
 * nothing broke.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_CALL_DURATION_MS,
  MAX_CALL_DURATION_WRAP_UP_LEAD_MS,
  MAX_CALL_DURATION_TERMINAL_REASON,
  resolveMaxCallDurationMs,
  hasReachedMaxCallDuration,
  maxCallDurationWarnDelayMs,
  maxCallDurationEffects,
} from '../../../../src/ai/voice-turn/shared/max-call-duration';
import { renderTtsText, MAX_CALL_DURATION_WRAP_UP_COPY } from '../../../../src/ai/agents/customer-calling/tts-copy';

const MINUTE_MS = 60_000;

describe('max call duration (shared)', () => {
  it('defaults to 15 minutes, a 30 s warning lead, and the max_call_duration terminal reason', () => {
    expect(DEFAULT_MAX_CALL_DURATION_MS).toBe(15 * MINUTE_MS);
    expect(MAX_CALL_DURATION_WRAP_UP_LEAD_MS).toBe(30_000);
    expect(MAX_CALL_DURATION_TERMINAL_REASON).toBe('max_call_duration');
    expect(resolveMaxCallDurationMs(undefined)).toBe(15 * MINUTE_MS);
    expect(resolveMaxCallDurationMs(2 * MINUTE_MS)).toBe(2 * MINUTE_MS);
  });

  it('a call is capped once its age reaches the limit', () => {
    const now = Date.now();
    const limit = 2 * MINUTE_MS;
    expect(hasReachedMaxCallDuration({ createdAt: new Date(now - limit + 1) }, limit, now)).toBe(false);
    expect(hasReachedMaxCallDuration({ createdAt: new Date(now - limit) }, limit, now)).toBe(true);
    expect(hasReachedMaxCallDuration({ createdAt: new Date(now - 16 * MINUTE_MS) }, limit, now)).toBe(true);
  });

  it('warns 30 s before the limit, or not at all when the limit is shorter than two leads', () => {
    expect(maxCallDurationWarnDelayMs(15 * MINUTE_MS)).toBe(15 * MINUTE_MS - 30_000);
    expect(maxCallDurationWarnDelayMs(60_000)).toBe(30_000);
    expect(maxCallDurationWarnDelayMs(59_999)).toBeNull();
  });

  it('speaks the wrap-up in the session language and ends with max_call_duration', () => {
    expect(maxCallDurationEffects({ language: 'es' })).toEqual([
      { type: 'tts_play', payload: { text: renderTtsText(MAX_CALL_DURATION_WRAP_UP_COPY, {}, 'es') } },
      { type: 'end_session', payload: { reason: 'max_call_duration' } },
    ]);
    expect(maxCallDurationEffects({ language: undefined })[0]).toEqual({
      type: 'tts_play',
      payload: { text: renderTtsText(MAX_CALL_DURATION_WRAP_UP_COPY, {}, 'en') },
    });
  });
});
