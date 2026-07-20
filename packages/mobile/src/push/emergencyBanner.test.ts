import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetEmergencyForTests,
  currentEmergency,
  dismissEmergency,
  raiseEmergency,
  subscribeEmergency,
} from './emergencyBanner';

afterEach(() => __resetEmergencyForTests());

describe('emergencyBanner store (U4/B7)', () => {
  it('starts empty; raise sets the alert with its receive time', () => {
    expect(currentEmergency()).toBeNull();
    raiseEmergency({ type: 'emergency', screen: '/approvals' }, 1_000);
    expect(currentEmergency()).toEqual({
      data: { type: 'emergency', screen: '/approvals' },
      receivedAt: 1_000,
    });
  });

  it('newest emergency wins; dismiss clears', () => {
    raiseEmergency({ type: 'escalation' }, 1);
    raiseEmergency({ type: 'emergency' }, 2);
    expect(currentEmergency()?.data.type).toBe('emergency');
    dismissEmergency();
    expect(currentEmergency()).toBeNull();
  });

  it('notifies subscribers on raise and dismiss; unsubscribe stops it', () => {
    const cb = vi.fn();
    const unsub = subscribeEmergency(cb);
    raiseEmergency({ type: 'emergency' }, 1);
    dismissEmergency();
    expect(cb).toHaveBeenCalledTimes(2);
    unsub();
    raiseEmergency({ type: 'emergency' }, 2);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('dismissing an already-empty store does not notify', () => {
    const cb = vi.fn();
    subscribeEmergency(cb);
    dismissEmergency();
    expect(cb).not.toHaveBeenCalled();
  });
});
