import { describe, it, expect } from 'vitest';
import { detectFrustration } from '../../../../src/ai/agents/customer-calling/frustration-detector';

describe('detectFrustration', () => {
  it('returns matched=true on explicit keyword', () => {
    expect(detectFrustration('this is ridiculous').matched).toBe(true);
    expect(detectFrustration('THIS IS RIDICULOUS').matched).toBe(true); // case-insensitive
    expect(detectFrustration("I'll just hang up").matched).toBe(true);
  });

  it('returns the matched keyword in the result', () => {
    const r = detectFrustration('this is ridiculous, just connect me');
    expect(r.matched).toBe(true);
    expect(r.keyword).toBe('this is ridiculous');
  });

  it('respects word boundaries — "forget the AC" does NOT match', () => {
    expect(detectFrustration('please forget the AC for now').matched).toBe(false);
  });

  it('returns matched=false on neutral text', () => {
    expect(detectFrustration('Yes, my address is 123 Main Street').matched).toBe(false);
    expect(detectFrustration('I need an appointment for Thursday').matched).toBe(false);
  });

  it('matches multi-word phrases anywhere in the transcript', () => {
    expect(detectFrustration('You know what, real person please').matched).toBe(true);
  });
});

describe('false-positive guards', () => {
  it('does not match "I\'m not frustrated"', () => {
    expect(detectFrustration("I'm not frustrated").matched).toBe(false);
  });
  it('does not match "I want a human technician" (after refinement)', () => {
    expect(detectFrustration('I want a human technician to come look').matched).toBe(false);
  });
  it('does not match conversational "talk" phrases without the human/person target', () => {
    expect(detectFrustration('I need to talk to my husband first').matched).toBe(false);
  });
  it('matches "talk to a human" exactly', () => {
    expect(detectFrustration('Can I talk to a human about this').matched).toBe(true);
  });
});
