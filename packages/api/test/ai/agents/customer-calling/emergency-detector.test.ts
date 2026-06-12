import { describe, it, expect } from 'vitest';
import {
  detectEmergency,
  EMERGENCY_KEYWORDS,
  EMERGENCY_SAFETY_LINE,
} from '../../../../src/ai/agents/customer-calling/emergency-detector';

describe('RV-140 — detectEmergency (deterministic keyword scan)', () => {
  it.each([
    ['I think we have a gas leak in the basement', 'gas leak'],
    ['it smells like gas down here', 'smells like gas'],
    ['my carbon monoxide alarm is going off', 'carbon monoxide'],
    ['the water heater caught fire', 'caught fire'],
    ['the outlet is sparking', 'sparking'],
    ['I smell electrical burning from the panel', 'electrical burning'],
    ['the basement is flooding fast', 'flooding'],
    ['we have a burst pipe upstairs', 'burst pipe'],
  ])('matches %j', (utterance, keyword) => {
    const result = detectEmergency(utterance);
    expect(result.matched).toBe(true);
    expect(result.keyword).toBe(keyword);
  });

  it('matches the compound no-heat + at-risk phrasing', () => {
    const result = detectEmergency(
      "our heat is out and it's freezing and we have a newborn",
    );
    expect(result.matched).toBe(true);
    expect(result.keyword).toContain('heat is out');
  });

  it('does NOT match a plain no-heat report without the risk phrasing', () => {
    expect(detectEmergency('my furnace is out, can you send someone next week').matched).toBe(false);
  });

  it('does NOT match routine scheduling language', () => {
    expect(detectEmergency('I want to book my annual AC tune-up').matched).toBe(false);
    expect(detectEmergency('can you fire over the estimate again').matched).toBe(false);
    expect(detectEmergency('the gas station on main street').matched).toBe(false);
  });

  it('is case-insensitive and word-bounded', () => {
    expect(detectEmergency('GAS LEAK!!').matched).toBe(true);
    // 'sparkling' must not hit 'sparking'.
    expect(detectEmergency('the sparkling water dispenser is broken').matched).toBe(false);
  });

  it('keyword table is non-empty platform defaults (per-tenant merge is out of scope)', () => {
    expect(EMERGENCY_KEYWORDS.length).toBeGreaterThan(5);
  });

  it('safety line references 911', () => {
    expect(EMERGENCY_SAFETY_LINE).toContain('911');
  });
});
