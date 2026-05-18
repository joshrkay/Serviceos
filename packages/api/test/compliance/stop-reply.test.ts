import { describe, expect, it } from 'vitest';
import {
  classifyInboundSms,
  STOP_KEYWORDS,
  START_KEYWORDS,
} from '../../src/compliance/stop-reply';

describe('classifyInboundSms', () => {
  it('returns "stop" for STOP keywords (case + whitespace + trailing punctuation insensitive)', () => {
    for (const w of STOP_KEYWORDS) {
      expect(classifyInboundSms(w)).toBe('stop');
      expect(classifyInboundSms(w.toLowerCase())).toBe('stop');
      expect(classifyInboundSms(`  ${w}  `)).toBe('stop');
      expect(classifyInboundSms(`${w}!`)).toBe('stop');
    }
  });

  it('returns "start" for START keywords', () => {
    for (const w of START_KEYWORDS) {
      expect(classifyInboundSms(w)).toBe('start');
      expect(classifyInboundSms(w.toLowerCase())).toBe('start');
    }
  });

  it('returns "other" for unrelated messages', () => {
    expect(classifyInboundSms('Sounds good, see you Friday')).toBe('other');
    expect(classifyInboundSms('Can we reschedule?')).toBe('other');
    expect(classifyInboundSms('')).toBe('other');
  });

  it('embedded keyword does not trigger (single-token match required)', () => {
    expect(classifyInboundSms('please stop calling me')).toBe('other');
    expect(classifyInboundSms('I would like to unsubscribe please')).toBe('other');
  });
});
