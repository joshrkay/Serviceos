/**
 * resolveOwnerEmail — the JWT email first, then the users row, then
 * tenants.owner_email; the lookup under the request tenant's context (raw-pg
 * audit 2026-10-23 §4 P2.3): the request transaction's client inside a request
 * for that tenant, otherwise one tenant session. Fake tenant pool
 * (test/helpers/fake-tenant-pool.ts); real Postgres in
 * test/integration/resolve-owner-email-tenant-context.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { resolveOwnerEmail } from '../../src/auth/resolve-owner-email';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { tenantContextStore } from '../../src/middleware/tenant-context';
import { fakeTenantPool } from '../helpers/fake-tenant-pool';

const TENANT = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';

function req(partial: Partial<AuthenticatedRequest>): AuthenticatedRequest {
  return partial as AuthenticatedRequest;
}

const owner = () =>
  req({ auth: { userId: 'user_abc', sessionId: 's', tenantId: TENANT, role: 'owner' } });

const verb = (sql: string) =>
  /set_config\('app\.current_tenant_id'/.test(sql) ? 'CONTEXT' : /COALESCE/.test(sql) ? 'LOOKUP' : sql.trim().split(/\s+/)[0]!;

describe('resolveOwnerEmail', () => {
  it('prefers clerkUser.email when present, without touching the database', async () => {
    const fake = fakeTenantPool();
    const email = await resolveOwnerEmail(
      req({
        clerkUser: { id: 'u1', email: 'from-jwt@example.com' },
        auth: { userId: 'u1', sessionId: 's', tenantId: TENANT, role: 'owner' },
      }),
      fake.pool,
    );
    expect(email).toBe('from-jwt@example.com');
    expect(fake.checkouts()).toBe(0);
  });

  it('off-request: falls back to users.email then tenants.owner_email in one tenant session', async () => {
    const fake = fakeTenantPool((sql) => (/COALESCE/.test(sql) ? { rows: [{ email: ' owner@shop.com ' }] } : undefined));

    const email = await resolveOwnerEmail(owner(), fake.pool);

    expect(email).toBe('owner@shop.com');
    expect(fake.statements.map((s) => [s.checkout, verb(s.sql)])).toEqual([
      [0, 'BEGIN'],
      [0, 'CONTEXT'],
      [0, 'LOOKUP'],
      [0, 'COMMIT'],
    ]);
    expect(fake.statements[1]!.values).toEqual([TENANT]);
    expect(fake.statements[2]!.values).toEqual([TENANT, 'user_abc']);
    expect(fake.open()).toBe(0);
  });

  it("inside a request for the tenant, the lookup rides the request's client: no checkout", async () => {
    const fake = fakeTenantPool();
    const ran: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        ran.push(sql);
        return { rows: [{ email: 'owner@shop.com' }] };
      }),
    } as unknown as PoolClient;

    const email = await tenantContextStore.run({ client, tenantId: TENANT }, () => resolveOwnerEmail(owner(), fake.pool));

    expect(email).toBe('owner@shop.com');
    expect(fake.checkouts()).toBe(0);
    expect(ran.map(verb)).toEqual(['LOOKUP']);
  });

  it("inside a request for ANOTHER tenant, the lookup does not borrow that request's client", async () => {
    const fake = fakeTenantPool((sql) => (/COALESCE/.test(sql) ? { rows: [{ email: 'owner@shop.com' }] } : undefined));
    const client = {
      query: vi.fn(async () => {
        throw new Error("ran on another tenant's request client");
      }),
    } as unknown as PoolClient;

    await tenantContextStore.run({ client, tenantId: OTHER }, () => resolveOwnerEmail(owner(), fake.pool));

    expect(client.query).not.toHaveBeenCalled();
    expect(fake.checkouts()).toBe(1);
    expect(fake.statements[1]!.values).toEqual([TENANT]);
  });

  it('a blank or missing email reads as null', async () => {
    const fake = fakeTenantPool((sql) => (/COALESCE/.test(sql) ? { rows: [{ email: '   ' }] } : undefined));
    expect(await resolveOwnerEmail(owner(), fake.pool)).toBeNull();
  });

  it('returns null when nothing is available (no pool, or no tenant)', async () => {
    expect(await resolveOwnerEmail(owner())).toBeNull();
    const fake = fakeTenantPool();
    expect(await resolveOwnerEmail(req({ auth: undefined }), fake.pool)).toBeNull();
    expect(fake.checkouts()).toBe(0);
  });
});
