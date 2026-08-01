import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyExpoTokenError,
  pushRegistrationKey,
  registerForPush,
  unregisterForPush,
  type RegisterPushDeps,
  type UnregisterPushDeps,
} from './registerForPush';

function makeDeps(over: Partial<RegisterPushDeps> = {}): RegisterPushDeps {
  return {
    getPermission: vi.fn().mockResolvedValue({ granted: true, canAskAgain: true }),
    requestPermission: vi.fn().mockResolvedValue({ granted: true }),
    getExpoPushToken: vi.fn().mockResolvedValue({ status: 'ok', token: 'ExponentPushToken[abc]' }),
    api: vi.fn().mockResolvedValue({ ok: true, status: 201 }) as unknown as RegisterPushDeps['api'],
    platform: 'ios',
    ...over,
  };
}

describe('registerForPush', () => {
  let deps: RegisterPushDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('posts the token + platform and returns "registered" on success', async () => {
    expect(await registerForPush(deps)).toBe('registered');
    expect(deps.api).toHaveBeenCalledWith('/api/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expoPushToken: 'ExponentPushToken[abc]', platform: 'ios' }),
    });
    expect(deps.requestPermission).not.toHaveBeenCalled(); // already granted
  });

  it('requests permission when not yet granted, then registers', async () => {
    deps = makeDeps({
      getPermission: vi.fn().mockResolvedValue({ granted: false, canAskAgain: true }),
      requestPermission: vi.fn().mockResolvedValue({ granted: true }),
    });
    expect(await registerForPush(deps)).toBe('registered');
    expect(deps.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('returns "denied" when permission is permanently denied (cannot ask again)', async () => {
    deps = makeDeps({
      getPermission: vi.fn().mockResolvedValue({ granted: false, canAskAgain: false }),
    });
    expect(await registerForPush(deps)).toBe('denied');
    expect(deps.getExpoPushToken).not.toHaveBeenCalled();
    expect(deps.api).not.toHaveBeenCalled();
  });

  it('returns "denied" when the user declines the prompt', async () => {
    deps = makeDeps({
      getPermission: vi.fn().mockResolvedValue({ granted: false, canAskAgain: true }),
      requestPermission: vi.fn().mockResolvedValue({ granted: false }),
    });
    expect(await registerForPush(deps)).toBe('denied');
    expect(deps.api).not.toHaveBeenCalled();
  });

  it('returns "unsupported" when no token is available (e.g. simulator)', async () => {
    deps = makeDeps({ getExpoPushToken: vi.fn().mockResolvedValue({ status: 'unsupported' }) });
    expect(await registerForPush(deps)).toBe('unsupported');
    expect(deps.api).not.toHaveBeenCalled();
  });

  it('returns "error" (retryable) on a transient token failure, without calling the API', async () => {
    // The whole point of the discriminated token result: a transient offline /
    // timeout failure must surface as 'error' (caller unlatches + retries), not
    // 'unsupported' (permanent latch). Regression guard for the latch bug.
    deps = makeDeps({ getExpoPushToken: vi.fn().mockResolvedValue({ status: 'error' }) });
    expect(await registerForPush(deps)).toBe('error');
    expect(deps.api).not.toHaveBeenCalled();
  });

  it('creates the Android channel before the permission/token flow', async () => {
    const order: string[] = [];
    deps = makeDeps({
      platform: 'android',
      ensureAndroidChannel: vi.fn().mockImplementation(async () => void order.push('channel')),
      getPermission: vi.fn().mockImplementation(async () => {
        order.push('permission');
        return { granted: true, canAskAgain: true };
      }),
      getExpoPushToken: vi.fn().mockImplementation(async () => {
        order.push('token');
        return { status: 'ok', token: 'ExponentPushToken[abc]' };
      }),
    });
    expect(await registerForPush(deps)).toBe('registered');
    expect(deps.ensureAndroidChannel).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['channel', 'permission', 'token']);
  });

  it('does not create a channel on iOS', async () => {
    const ensureAndroidChannel = vi.fn();
    deps = makeDeps({ platform: 'ios', ensureAndroidChannel });
    await registerForPush(deps);
    expect(ensureAndroidChannel).not.toHaveBeenCalled();
  });

  it('returns "error" on a non-ok API response or a thrown error', async () => {
    expect(
      await registerForPush(
        makeDeps({ api: vi.fn().mockResolvedValue({ ok: false, status: 500 }) as never }),
      ),
    ).toBe('error');
    expect(
      await registerForPush(
        makeDeps({ getExpoPushToken: vi.fn().mockRejectedValue(new Error('boom')) }),
      ),
    ).toBe('error');
  });
});

describe('unregisterForPush', () => {
  function deps(over: Partial<UnregisterPushDeps> = {}): UnregisterPushDeps {
    return {
      getExpoPushToken: vi.fn().mockResolvedValue({ status: 'ok', token: 'ExponentPushToken[abc]' }),
      api: vi.fn().mockResolvedValue({ ok: true, status: 204 }) as unknown as UnregisterPushDeps['api'],
      ...over,
    };
  }

  it('DELETEs the token from /api/devices', async () => {
    const d = deps();
    await unregisterForPush(d);
    expect(d.api).toHaveBeenCalledWith('/api/devices', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expoPushToken: 'ExponentPushToken[abc]' }),
    });
  });

  it('no token → no call', async () => {
    const d = deps({ getExpoPushToken: vi.fn().mockResolvedValue({ status: 'unsupported' }) });
    await unregisterForPush(d);
    expect(d.api).not.toHaveBeenCalled();
  });

  it('swallows errors (never blocks sign-out)', async () => {
    const d = deps({ api: vi.fn().mockRejectedValue(new Error('network')) as never });
    await expect(unregisterForPush(d)).resolves.toBeUndefined();
  });
});

describe('classifyExpoTokenError', () => {
  it('treats the unsupported-device error code as permanent', () => {
    expect(classifyExpoTokenError({ code: 'ERR_NOTIFICATIONS_DEVICE_NOT_SUPPORTED' })).toBe(
      'unsupported',
    );
    expect(classifyExpoTokenError({ code: 'E_DEVICE_NOT_SUPPORTED' })).toBe('unsupported');
  });

  it('treats the "must use a physical device" message as permanent', () => {
    expect(classifyExpoTokenError(new Error('Must use physical device for push notifications'))).toBe(
      'unsupported',
    );
  });

  it('treats network/timeout errors as transient (retryable)', () => {
    expect(classifyExpoTokenError(new Error('Network request failed'))).toBe('error');
    expect(classifyExpoTokenError(new Error('timeout fetching projectId'))).toBe('error');
    expect(classifyExpoTokenError(undefined)).toBe('error');
  });
});

describe('pushRegistrationKey', () => {
  it('is null when signed out so a later sign-in re-registers', () => {
    expect(pushRegistrationKey(false, 'org_123')).toBeNull();
    expect(pushRegistrationKey(false, null)).toBeNull();
  });

  it('keys by active org so an in-session tenant switch re-registers', () => {
    expect(pushRegistrationKey(true, 'org_a')).toBe('org_a');
    expect(pushRegistrationKey(true, 'org_b')).toBe('org_b');
    expect(pushRegistrationKey(true, 'org_a')).not.toBe(pushRegistrationKey(true, 'org_b'));
  });

  it('falls back to a stable personal key when there is no active org', () => {
    expect(pushRegistrationKey(true, null)).toBe('personal');
    expect(pushRegistrationKey(true, undefined)).toBe('personal');
  });
});
