import { describe, expect, it, beforeEach } from 'vitest';
import {
  registerDroppedCallSession,
  lookupDroppedCallSession,
  __clearDroppedCallSessionBridgeForTests,
} from '../../src/telephony/dropped-call-session-bridge';

describe('dropped-call-session-bridge', () => {
  beforeEach(() => {
    __clearDroppedCallSessionBridgeForTests();
  });

  it('resolves session by normalized phone within tenant', () => {
    registerDroppedCallSession('t1', '+15551234567', 'sess-1');
    expect(lookupDroppedCallSession('t1', '+1 (555) 123-4567')).toBe('sess-1');
    expect(lookupDroppedCallSession('t2', '+15551234567')).toBeUndefined();
  });
});
