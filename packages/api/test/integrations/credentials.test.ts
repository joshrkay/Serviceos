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

  const T1 = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';

  /** A pool whose checked-out client answers the credential SELECT with `versions` in turn. */
  function credentialPool(versions: number[]) {
    const remaining = [...versions];
    const client = {
      query: vi.fn(async (sql: string) =>
        /FROM tenant_integrations/.test(sql)
          ? { rows: [{ tenant_id: T1, provider: 'twilio', credentials: {}, credential_version: remaining.shift() }] }
          : { rows: [] },
      ),
      release: vi.fn(),
    };
    const pool = { options: { connectionString: 'postgres://test' }, connect: vi.fn(async () => client) } as any;
    const selects = () => client.query.mock.calls.filter((call) => /FROM tenant_integrations/.test(String(call[0])));
    return { pool, client, selects };
  }

  it('invalidates a cache entry on notification and re-queries pool', async () => {
    const { createCredentialResolver } = await import('../../src/integrations/credentials');
    const { pool, selects } = credentialPool([1, 2]);

    const listener = new FakeListener();
    const resolver = createCredentialResolver({ pool, createListener: () => listener as any });
    await Promise.resolve();

    await resolver.getCredential(T1, 'twilio');
    await resolver.getCredential(T1, 'twilio');
    expect(selects()).toHaveLength(1);

    listener.emit('notification', { channel: 'tenant_integration_rotated', payload: `${T1}:twilio` });
    const afterRotate = await resolver.getCredential(T1, 'twilio');

    expect(afterRotate?.credential_version).toBe(2);
    expect(selects()).toHaveLength(2);

    await resolver.close();
  });

  it('reads the row in its own transaction with tenant context and the RLS runtime role', async () => {
    const original = process.env.RLS_RUNTIME_ROLE;
    process.env.RLS_RUNTIME_ROLE = 'true';
    try {
      const { createCredentialResolver } = await import('../../src/integrations/credentials');
      const { pool, client } = credentialPool([1]);
      const resolver = createCredentialResolver({ pool, createListener: () => new FakeListener() as any });

      await resolver.getCredential(T1, 'twilio');

      const sqls = client.query.mock.calls.map((call) => String(call[0]).trim());
      expect(sqls[0]).toBe('BEGIN');
      expect(sqls[1]).toBe("SELECT set_config('app.current_tenant_id', $1, true)");
      expect(client.query.mock.calls[1][1]).toEqual([T1]);
      expect(sqls[2]).toBe('SET LOCAL ROLE rls_app_runtime');
      expect(sqls[3]).toMatch(/FROM tenant_integrations/);
      expect(sqls[4]).toBe('COMMIT');
      expect(client.release).toHaveBeenCalledTimes(1);
      await resolver.close();
    } finally {
      if (original === undefined) delete process.env.RLS_RUNTIME_ROLE;
      else process.env.RLS_RUNTIME_ROLE = original;
    }
  });

  it('carries the pool ssl setting onto the LISTEN client (Codex review, #1744)', async () => {
    // A bare connectionString would leave the listener on pg defaults (no
    // certificate verification) while every pooled connection verifies.
    const { createCredentialResolver } = await import('../../src/integrations/credentials');
    const ssl = { rejectUnauthorized: true, ca: 'CA' };
    const pool = {
      options: { connectionString: 'postgres://pgbouncer/app', ssl },
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as any;
    const directPool = {
      options: { connectionString: 'postgres://direct/app', ssl },
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as any;

    const listener = new FakeListener();
    const createListener = vi.fn(() => listener as any);
    const resolver = createCredentialResolver({ pool, directPool, createListener });

    expect(createListener).toHaveBeenCalledWith({ connectionString: 'postgres://direct/app', ssl });
    await resolver.close();
  });

  it('builds the LISTEN client from host/port fields, ssl included, when there is no DSN', async () => {
    const { createCredentialResolver } = await import('../../src/integrations/credentials');
    const pool = {
      options: { host: 'db', port: 5432, user: 'u', password: 'p', database: 'app', ssl: false },
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as any;

    const createListener = vi.fn(() => new FakeListener() as any);
    const resolver = createCredentialResolver({ pool, createListener });

    expect(createListener).toHaveBeenCalledWith({
      host: 'db',
      port: 5432,
      user: 'u',
      password: 'p',
      database: 'app',
      ssl: false,
    });
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
