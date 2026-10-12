import { describe, it, expect } from 'vitest';
import { createAuthFailureThrottle } from '../../src/webhooks/auth-failure-throttle';

describe('createAuthFailureThrottle', () => {
  it('admits the first event per key, suppresses repeats inside the window', () => {
    const t = createAuthFailureThrottle({ windowMs: 1000, maxKeys: 10 });
    expect(t.admit('a', 0)).toEqual({ suppressedSinceLast: 0 });
    expect(t.admit('a', 10)).toBeNull();
    expect(t.admit('a', 999)).toBeNull();
    expect(t.admit('b', 10)).toEqual({ suppressedSinceLast: 0 });
  });

  it('admits again after the window and reports how many were suppressed', () => {
    const t = createAuthFailureThrottle({ windowMs: 1000, maxKeys: 10 });
    t.admit('a', 0);
    t.admit('a', 100);
    t.admit('a', 200);
    expect(t.admit('a', 1000)).toEqual({ suppressedSinceLast: 2 });
    expect(t.admit('a', 1500)).toBeNull();
  });

  it('bounds memory by evicting the least recently admitted key', () => {
    const t = createAuthFailureThrottle({ windowMs: 60_000, maxKeys: 2 });
    t.admit('a', 0);
    t.admit('b', 1);
    t.admit('c', 2); // evicts 'a'
    expect(t.admit('b', 3)).toBeNull(); // still tracked
    expect(t.admit('a', 4)).toEqual({ suppressedSinceLast: 0 }); // forgotten → admitted
  });
});
