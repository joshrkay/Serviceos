/**
 * The Postgres UserModeService under tenant context (raw-pg audit 2026-10-23
 * §4 P2.1), on the fake tenant pool (test/helpers/fake-tenant-pool.ts); real
 * Postgres in test/integration/user-mode-tenant-context.test.ts.
 *
 * - The three reads (getUser — requireTenant's mode loader on every /api
 *   request — getTenantSettings, getTenantIntegrationStatuses) ride the
 *   request transaction's client inside a request for the same tenant (no
 *   checkout), and otherwise run in one tenant session each.
 * - setMode never joins the request: it commits in a tenant session of its
 *   own, as the bare pool.query it replaces did.
 * - The mode loader requireTenant uses turns a failed read into null.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Response } from 'express';
import type { PoolClient } from 'pg';
import { createPgUserModeService, createUserModeLoader } from '../../src/users/pg-user-mode-service';
import { tenantContextStore } from '../../src/middleware/tenant-context';
import { clearUserModeCacheForTests, requireTenant, setUserModeLoader } from '../../src/middleware/auth';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { fakeTenantPool } from '../helpers/fake-tenant-pool';

const TENANT = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const CLERK = 'user_2mode';

const USER_ROW = {
  id: '77777777-7777-4777-8777-777777777777',
  clerk_user_id: CLERK,
  tenant_id: TENANT,
  role: 'dispatcher',
  can_field_serve: true,
  current_mode: 'tech',
  mode_changed_at: '2026-10-01T12:00:00.000Z',
};

function respond(sql: string) {
  if (/FROM users/.test(sql)) return { rows: [USER_ROW] };
  if (/FROM tenant_settings/.test(sql)) {
    return { rows: [{ backup_supervisor_user_id: null, unsupervised_proposal_routing: 'queue_only', timezone: 'America/Phoenix' }] };
  }
  if (/FROM tenant_integrations/.test(sql)) {
    return { rows: [{ provider: 'twilio', status: 'active', updated_at: '2026-10-02T00:00:00.000Z' }] };
  }
  if (/^\s*UPDATE users/.test(sql)) return { rows: [], rowCount: 1 };
  return undefined;
}

const verb = (sql: string) =>
  /set_config\('app\.current_tenant_id'/.test(sql) ? 'CONTEXT' : sql.trim().split(/\s+/)[0]!;

/** A request transaction's client for `tenantId`, as the /api middleware publishes it. */
function requestClient(answer: (sql: string) => unknown = respond) {
  const ran: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      ran.push(sql);
      return answer(sql) ?? { rows: [], rowCount: 0 };
    }),
  } as unknown as PoolClient;
  return { client, ran };
}

afterEach(() => {
  setUserModeLoader(null);
  clearUserModeCacheForTests();
});

describe('createPgUserModeService — reads', () => {
  it('off-request, each read is one tenant session: BEGIN, the GUC + role, the read, COMMIT', async () => {
    const fake = fakeTenantPool(respond);
    const service = createPgUserModeService(fake.pool);

    const user = await service.getUser(TENANT, CLERK);
    const settings = await service.getTenantSettings(TENANT);
    const statuses = await service.getTenantIntegrationStatuses(TENANT);

    expect(fake.statements.map((s) => [s.checkout, verb(s.sql)])).toEqual([
      [0, 'BEGIN'], [0, 'CONTEXT'], [0, 'SELECT'], [0, 'COMMIT'],
      [1, 'BEGIN'], [1, 'CONTEXT'], [1, 'SELECT'], [1, 'COMMIT'],
      [2, 'BEGIN'], [2, 'CONTEXT'], [2, 'SELECT'], [2, 'COMMIT'],
    ]);
    for (const i of [1, 5, 9]) expect(fake.statements[i]!.values).toEqual([TENANT]);
    expect(fake.open()).toBe(0);
    expect(user).toEqual({
      user_id: CLERK,
      internal_user_id: USER_ROW.id,
      tenant_id: TENANT,
      role: 'dispatcher',
      can_field_serve: true,
      current_mode: 'tech',
      mode_changed_at: new Date(USER_ROW.mode_changed_at),
    });
    expect(settings).toEqual({ backup_supervisor_user_id: null, unsupervised_proposal_routing: 'queue_only', timezone: 'America/Phoenix' });
    expect(statuses).toEqual([{ provider: 'twilio', status: 'active', updated_at: new Date('2026-10-02T00:00:00.000Z') }]);
  });

  it("inside a request for the tenant, all three reads ride the request's client: no checkout", async () => {
    const fake = fakeTenantPool(respond);
    const service = createPgUserModeService(fake.pool);
    const req = requestClient();

    await tenantContextStore.run({ client: req.client, tenantId: TENANT }, async () => {
      await service.getUser(TENANT, CLERK);
      await service.getTenantSettings(TENANT);
      await service.getTenantIntegrationStatuses(TENANT);
    });

    expect(fake.checkouts()).toBe(0);
    expect(req.ran.map(verb)).toEqual(['SELECT', 'SELECT', 'SELECT']);
    expect(req.ran[0]).toMatch(/FROM users\s+WHERE tenant_id = \$1 AND clerk_user_id = \$2/);
  });

  it("inside a request for ANOTHER tenant, a read does not borrow that request's client", async () => {
    const fake = fakeTenantPool(respond);
    const service = createPgUserModeService(fake.pool);
    const req = requestClient(() => {
      throw new Error("ran on another tenant's request client");
    });

    await tenantContextStore.run({ client: req.client, tenantId: OTHER }, () => service.getUser(TENANT, CLERK));

    expect(req.ran).toEqual([]);
    expect(fake.checkouts()).toBe(1);
    expect(fake.statements[1]!.values).toEqual([TENANT]);
  });

  it('no users row reads as null; no tenant_settings row reads as the defaults', async () => {
    const fake = fakeTenantPool(() => ({ rows: [], rowCount: 0 }));
    const service = createPgUserModeService(fake.pool);

    expect(await service.getUser(TENANT, CLERK)).toBeNull();
    expect(await service.getTenantSettings(TENANT)).toEqual({
      backup_supervisor_user_id: null,
      unsupervised_proposal_routing: 'queue_and_sms',
      timezone: 'America/New_York',
    });
  });
});

describe('createPgUserModeService — setMode commits on its own', () => {
  it('off-request: one tenant session around the UPDATE', async () => {
    const fake = fakeTenantPool(respond);
    const service = createPgUserModeService(fake.pool);

    const { modeChangedAt } = await service.setMode(TENANT, CLERK, 'both');

    expect(fake.statements.map((s) => verb(s.sql))).toEqual(['BEGIN', 'CONTEXT', 'UPDATE', 'COMMIT']);
    expect(fake.statements[2]!.values).toEqual(['both', modeChangedAt, TENANT, CLERK]);
    expect(fake.open()).toBe(0);
  });

  it("inside a request for the same tenant, the UPDATE still runs in a session of its own, never on the request's client", async () => {
    const fake = fakeTenantPool(respond);
    const service = createPgUserModeService(fake.pool);
    const req = requestClient();

    await tenantContextStore.run({ client: req.client, tenantId: TENANT }, () => service.setMode(TENANT, CLERK, 'tech'));

    expect(req.ran).toEqual([]);
    expect(fake.checkouts()).toBe(1);
    expect(fake.statements.map((s) => verb(s.sql))).toEqual(['BEGIN', 'CONTEXT', 'UPDATE', 'COMMIT']);
  });

  it('a failed UPDATE rolls its session back and rejects', async () => {
    const fake = fakeTenantPool((sql) => {
      if (/^\s*UPDATE users/.test(sql)) throw new Error('boom');
      return undefined;
    });
    const service = createPgUserModeService(fake.pool);

    await expect(service.setMode(TENANT, CLERK, 'tech')).rejects.toThrow('boom');
    expect(fake.statements.map((s) => verb(s.sql))).toEqual(['BEGIN', 'CONTEXT', 'UPDATE', 'ROLLBACK']);
    expect(fake.open()).toBe(0);
  });
});

describe("requireTenant's mode loader over the Pg service", () => {
  function run(req: AuthenticatedRequest): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const res = { status: () => ({ json: () => reject(new Error('rejected')) }) } as unknown as Response;
      void requireTenant(req, res, (() => resolve()) as NextFunction);
    });
  }
  const authed = () => ({ auth: { userId: CLERK, sessionId: 's', tenantId: TENANT, role: 'dispatcher' } }) as AuthenticatedRequest;

  it('inside the request transaction, a cache miss reads the mode on the request client (no checkout), a hit reads nothing', async () => {
    const fake = fakeTenantPool(respond);
    setUserModeLoader(createUserModeLoader(createPgUserModeService(fake.pool)));
    const req = requestClient();
    const first = authed();
    const second = authed();

    await tenantContextStore.run({ client: req.client, tenantId: TENANT }, async () => {
      await run(first);
      await run(second);
    });

    expect((first.auth as { mode?: string }).mode).toBe('tech');
    expect((second.auth as { mode?: string }).mode).toBe('tech');
    expect(fake.checkouts()).toBe(0);
    expect(req.ran.map(verb)).toEqual(['SELECT']);
  });

  it('with no request transaction (an SSE or long-LLM route), a miss is one tenant session', async () => {
    const fake = fakeTenantPool(respond);
    setUserModeLoader(createUserModeLoader(createPgUserModeService(fake.pool)));
    const req = authed();

    await run(req);

    expect((req.auth as { mode?: string }).mode).toBe('tech');
    expect(fake.statements.map((s) => verb(s.sql))).toEqual(['BEGIN', 'CONTEXT', 'SELECT', 'COMMIT']);
  });

  it('a failed read is null to the loader, so requireTenant keeps its supervisor default', async () => {
    const fake = fakeTenantPool((sql) => {
      if (/FROM users/.test(sql)) throw new Error('db blip');
      return undefined;
    });
    const loader = createUserModeLoader(createPgUserModeService(fake.pool));

    expect(await loader(CLERK, TENANT)).toBeNull();
    setUserModeLoader(loader);
    const req = authed();
    await run(req);
    expect((req.auth as { mode?: string }).mode).toBe('supervisor');
  });
});
