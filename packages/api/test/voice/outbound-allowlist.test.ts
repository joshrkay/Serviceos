import { describe, it, expect } from 'vitest';
import { isOutboundAllowed } from '../../src/voice/outbound-allowlist';

describe('isOutboundAllowed', () => {
  it('allows US numbers', () => {
    expect(isOutboundAllowed('+15125551234').allowed).toBe(true);
  });

  it('allows Canadian numbers', () => {
    expect(isOutboundAllowed('+14165551234').allowed).toBe(true);
  });

  it('blocks non-NANP', () => {
    expect(isOutboundAllowed('+447911123456').allowed).toBe(false);
    expect(isOutboundAllowed('+819011234567').allowed).toBe(false);
  });

  it('blocks 900 and 976 NPAs', () => {
    expect(isOutboundAllowed('+19005551234').reason).toBe('premium_npa');
    expect(isOutboundAllowed('+19765551234').reason).toBe('premium_npa');
  });

  it('rejects malformed numbers', () => {
    expect(isOutboundAllowed('not a number').allowed).toBe(false);
  });
});
