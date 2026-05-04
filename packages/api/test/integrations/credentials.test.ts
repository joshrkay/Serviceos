import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeListener {
  handlers = new Map<string, Set<(...args: any[]) => void>>();
  connect = vi.fn(async () => undefined);
  end = vi.fn(async () => undefined);
  query = vi.fn(async () => ({ rows: [] }));

  on(event: string, cb: (...args: any[]) => void): this {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)?.add(cb);
    return this;
  }

  off(event: string, cb: (...args: any[]) => void): this {
    this.handlers.get(event)?.delete(cb);
    return this;
  }

  emit(event: string, payload?: any): void {
    for (const cb of this.handlers.get(event) ?? []) cb(payload);
  }
}

vi.mock('pg', () => ({ Client: class {} }));

describe('createCredentialResolver', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('invalidates a cache entry on notification and re-queries pool', async () => {
    const { createCredentialResolver } = await import('../../src/integrations/credentials');
    const pool = {
      options: { connectionString: 'postgres://test' },
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ tenant_id: 't1', provider: 'twilio', credentials: {}, credential_version: 1 }] })
        .mockResolvedValueOnce({ rows: [{ tenant_id: 't1', provider: 'twilio', credentials: {}, credential_version: 2 }] }),
    } as any;

    const listener = new FakeListener();
    const resolver = createCredentialResolver({ pool, createListener: () => listener as any });
    await Promise.resolve();

    await resolver.getCredential('t1', 'twilio');
    await resolver.getCredential('t1', 'twilio');
    expect(pool.query).toHaveBeenCalledTimes(1);

    listener.emit('notification', { channel: 'tenant_integration_rotated', payload: 't1:twilio' });
    const afterRotate = await resolver.getCredential('t1', 'twilio');

    expect(afterRotate?.credential_version).toBe(2);
    expect(pool.query).toHaveBeenCalledTimes(2);

    await resolver.close();
  });

  it('reconnects and re-listens after listener error', async () => {
    const { createCredentialResolver } = await import('../../src/integrations/credentials');
    const pool = {
      options: { connectionString: 'postgres://test' },
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as any;

    const listener = new FakeListener();
    listener.connect.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);

    const sleep = vi.fn(async () => undefined);
    const resolver = createCredentialResolver({ pool, createListener: () => listener as any, sleep });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listener.query).toHaveBeenCalledWith('LISTEN tenant_integration_rotated');

    listener.emit('error', new Error('lost'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listener.end).toHaveBeenCalled();
    expect(listener.query).toHaveBeenCalledWith('LISTEN tenant_integration_rotated');

    await resolver.close();
    expect(listener.query).toHaveBeenCalledWith('UNLISTEN tenant_integration_rotated');
  });
});
