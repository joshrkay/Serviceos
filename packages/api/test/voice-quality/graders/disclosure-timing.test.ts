import { describe, it, expect } from 'vitest';
import {
  gradeDisclosureTiming,
  DISCLOSURE_DEADLINE_MS,
} from '../../../src/ai/voice-quality/graders/disclosure-timing';
import type { VoiceSessionEvent } from '../../../src/ai/agents/customer-calling/voice-session-store';

function speech(transcript: string, ts: number, turnIndex = 0): VoiceSessionEvent {
  return { type: 'speech_outbound', transcript, turnIndex, ts };
}

describe('RV-131 — gradeDisclosureTiming (report-only)', () => {
  it('passes when the disclosure rides the greeting (deltaMs 0 — production shape)', () => {
    const result = gradeDisclosureTiming({
      events: [
        speech(
          'Thank you for calling Acme. This call may be recorded for quality and training purposes. How can I help?',
          1_000,
        ),
      ],
    });
    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.deltaMs).toBe(0);
  });

  it('passes when the disclosure lands within 10s of the greeting', () => {
    const result = gradeDisclosureTiming({
      events: [
        speech('Hi! How can I help you today?', 1_000),
        speech('Quick note — this call may be recorded.', 1_000 + DISCLOSURE_DEADLINE_MS),
      ],
    });
    expect(result.passed).toBe(true);
    expect(result.deltaMs).toBe(DISCLOSURE_DEADLINE_MS);
  });

  it('fails when the disclosure arrives later than 10s', () => {
    const result = gradeDisclosureTiming({
      events: [
        speech('Hi! How can I help you today?', 1_000),
        speech('By the way, this call may be recorded.', 1_000 + DISCLOSURE_DEADLINE_MS + 1),
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.deltaMs).toBe(DISCLOSURE_DEADLINE_MS + 1);
    expect(result.reason).toContain('after greeting');
  });

  it('fails when no disclosure is ever spoken', () => {
    const result = gradeDisclosureTiming({
      events: [speech('Hi! How can I help you today?', 1_000)],
    });
    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.deltaMs).toBeNull();
  });

  it('not applicable when the observation has no agent speech', () => {
    const result = gradeDisclosureTiming({ events: [] });
    expect(result.applicable).toBe(false);
    expect(result.passed).toBe(true);
  });

  it('matches the Spanish disclosure copy', () => {
    const result = gradeDisclosureTiming({
      events: [speech('Esta llamada puede ser grabada con fines de calidad.', 5)],
    });
    expect(result.passed).toBe(true);
  });
});
