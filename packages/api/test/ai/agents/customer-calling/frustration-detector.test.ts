import { describe, it, expect } from 'vitest';
import { detectFrustration } from '../../../../src/ai/agents/customer-calling/frustration-detector';

describe('detectFrustration', () => {
  it('returns matched=true on explicit keyword', () => {
    expect(detectFrustration('this is ridiculous').matched).toBe(true);
    expect(detectFrustration('THIS IS RIDICULOUS').matched).toBe(true); // case-insensitive
    expect(detectFrustration("I'll just hang up").matched).toBe(true);
  });

  it('returns the matched keyword in the result', () => {
    const r = detectFrustration('forget it, just connect me');
    expect(r.matched).toBe(true);
    expect(r.keyword).toBe('forget it');
  });

  it('respects word boundaries — "forget the AC" does NOT match "forget it"', () => {
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
