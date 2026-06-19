import { describe, it, expect, vi } from 'vitest';
import { createAppLock } from './appLock';

describe('createAppLock', () => {
  it('starts locked when enabled and unlocked when disabled', () => {
    const enabled = createAppLock({ isEnabled: () => true, authenticate: async () => true });
    expect(enabled.start()).toBe('locked');
    const disabled = createAppLock({ isEnabled: () => false, authenticate: async () => true });
    expect(disabled.start()).toBe('unlocked');
  });

  it('unlocks on a successful check and notifies subscribers', async () => {
    const states: string[] = [];
    const lock = createAppLock({ isEnabled: () => true, authenticate: async () => true });
    lock.subscribe((s) => states.push(s));
    lock.start();
    expect(lock.getState()).toBe('locked');
    expect(await lock.unlock()).toBe(true);
    expect(lock.getState()).toBe('unlocked');
    expect(states).toEqual(['locked', 'unlocked']);
  });

  it('stays locked when the check fails', async () => {
    const lock = createAppLock({ isEnabled: () => true, authenticate: async () => false });
    lock.start();
    expect(await lock.unlock()).toBe(false);
    expect(lock.getState()).toBe('locked');
  });

  it('stays locked when the check throws (no bypass)', async () => {
    const lock = createAppLock({
      isEnabled: () => true,
      authenticate: async () => {
        throw new Error('sensor error');
      },
    });
    lock.start();
    expect(await lock.unlock()).toBe(false);
    expect(lock.getState()).toBe('locked');
  });

  it('unlock is a no-op (no auth prompt) when already unlocked', async () => {
    const authenticate = vi.fn(async () => true);
    const lock = createAppLock({ isEnabled: () => false, authenticate });
    lock.start();
    expect(await lock.unlock()).toBe(true);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('re-locks on resume when enabled', async () => {
    const lock = createAppLock({ isEnabled: () => true, authenticate: async () => true });
    lock.start();
    await lock.unlock();
    expect(lock.getState()).toBe('unlocked');
    expect(lock.onResume()).toBe('locked');
  });

  it('does not lock on resume when disabled', () => {
    const lock = createAppLock({ isEnabled: () => false, authenticate: async () => true });
    lock.start();
    expect(lock.onResume()).toBe('unlocked');
  });

  it('stops notifying after unsubscribe', async () => {
    const states: string[] = [];
    const lock = createAppLock({ isEnabled: () => true, authenticate: async () => true });
    const off = lock.subscribe((s) => states.push(s));
    lock.start();
    off();
    await lock.unlock();
    expect(states).toEqual(['locked']);
  });
});
