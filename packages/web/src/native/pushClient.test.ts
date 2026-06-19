import { describe, it, expect, vi } from 'vitest';
import { createPushClient, type PushPorts } from './pushClient';

function makePorts(overrides: Partial<PushPorts> = {}): PushPorts {
  return {
    requestPermission: vi.fn(async () => true),
    getToken: vi.fn(async () => 'fcm-token'),
    platform: () => 'ios',
    registerToken: vi.fn(async () => {}),
    unregisterToken: vi.fn(async () => {}),
    parseLink: vi.fn((url: string) => (url.startsWith('https://app.rivet.com') ? '/e/1' : null)),
    navigate: vi.fn(),
    ...overrides,
  };
}

describe('createPushClient', () => {
  it('registers the token after permission + token acquisition', async () => {
    const ports = makePorts();
    const res = await createPushClient(ports).register();
    expect(res).toEqual({ registered: true, token: 'fcm-token' });
    expect(ports.registerToken).toHaveBeenCalledWith('ios', 'fcm-token');
  });

  it('does not register when permission is denied', async () => {
    const ports = makePorts({ requestPermission: vi.fn(async () => false) });
    const res = await createPushClient(ports).register();
    expect(res.registered).toBe(false);
    expect(ports.getToken).not.toHaveBeenCalled();
    expect(ports.registerToken).not.toHaveBeenCalled();
  });

  it('does not register when no token is returned', async () => {
    const ports = makePorts({ getToken: vi.fn(async () => null) });
    const res = await createPushClient(ports).register();
    expect(res).toEqual({ registered: false, token: null });
    expect(ports.registerToken).not.toHaveBeenCalled();
  });

  it('reports not-registered when the POST fails (app continues)', async () => {
    const ports = makePorts({
      registerToken: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    const res = await createPushClient(ports).register();
    expect(res).toEqual({ registered: false, token: 'fcm-token' });
  });

  it('routes a notification tap with a link through the parser', () => {
    const ports = makePorts();
    createPushClient(ports).handleNotificationTap({ link: 'https://app.rivet.com/e/1' });
    expect(ports.navigate).toHaveBeenCalledWith('/e/1');
  });

  it('ignores a tap whose link is foreign (parser returns null)', () => {
    const ports = makePorts();
    createPushClient(ports).handleNotificationTap({ link: 'https://evil.com/x' });
    expect(ports.navigate).not.toHaveBeenCalled();
  });

  it('navigates a bare path payload', () => {
    const ports = makePorts();
    createPushClient(ports).handleNotificationTap({ path: '/jobs/9' });
    expect(ports.navigate).toHaveBeenCalledWith('/jobs/9');
  });

  it('ignores an empty tap payload', () => {
    const ports = makePorts();
    createPushClient(ports).handleNotificationTap(undefined);
    expect(ports.navigate).not.toHaveBeenCalled();
  });

  it('unregisters the registered token on logout', async () => {
    const ports = makePorts();
    const client = createPushClient(ports);
    await client.register();
    await client.unregister();
    expect(ports.unregisterToken).toHaveBeenCalledWith('fcm-token');
  });

  it('unregister is a no-op when nothing was registered', async () => {
    const ports = makePorts();
    await createPushClient(ports).unregister();
    expect(ports.unregisterToken).not.toHaveBeenCalled();
  });
});
