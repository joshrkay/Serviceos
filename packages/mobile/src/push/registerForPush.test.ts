import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerForPush,
  unregisterForPush,
  type RegisterPushDeps,
  type UnregisterPushDeps,
} from './registerForPush';

function makeDeps(over: Partial<RegisterPushDeps> = {}): RegisterPushDeps {
  return {
    getPermission: vi.fn().mockResolvedValue({ granted: true, canAskAgain: true }),
    requestPermission: vi.fn().mockResolvedValue({ granted: true }),
    getExpoPushToken: vi.fn().mockResolvedValue('ExponentPushToken[abc]'),
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
    deps = makeDeps({ getExpoPushToken: vi.fn().mockResolvedValue(null) });
    expect(await registerForPush(deps)).toBe('unsupported');
    expect(deps.api).not.toHaveBeenCalled();
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
      getExpoPushToken: vi.fn().mockResolvedValue('ExponentPushToken[abc]'),
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
    const d = deps({ getExpoPushToken: vi.fn().mockResolvedValue(null) });
    await unregisterForPush(d);
    expect(d.api).not.toHaveBeenCalled();
  });

  it('swallows errors (never blocks sign-out)', async () => {
    const d = deps({ api: vi.fn().mockRejectedValue(new Error('network')) as never });
    await expect(unregisterForPush(d)).resolves.toBeUndefined();
  });
});
