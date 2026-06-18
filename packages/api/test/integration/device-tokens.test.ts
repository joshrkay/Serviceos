/**
 * Postgres integration — device_tokens.
 *
 * Two layers of proof:
 *   1. The PgDeviceTokenRepository (run as the testcontainer superuser, which
 *      bypasses RLS) pins the real columns, the upsert semantics, and the
 *      (tenant_id, token) uniqueness against the actual schema.
 *   2. RLS isolation is observed through an unprivileged `rls_app_runtime`
 *      role (superusers bypass RLS), mirroring rls-tenant-isolation.test.ts —
 *      the production runtime connects as such a role.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgDeviceTokenRepository } from '../../src/devices/device-token-repository';

const APP_ROLE = 'rls_app_runtime';

async function asTenant<T>(
  pool: Pool,
  tenantId: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    if (tenantId !== null) {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    }
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('Postgres integration — device_tokens', () => {
  let pool: Pool;
  let repo: PgDeviceTokenRepository;
  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgDeviceTokenRepository(pool);

    // Unprivileged role to observe RLS (the superuser pool bypasses it).
    // Idempotent so it coexists with rls-tenant-isolation.test.ts.
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} NOLOGIN NOBYPASSRLS;
      END IF;
    END $$;`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);

    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('repository CRUD (real columns)', () => {
    it('registers and reads back real columns with UTC timestamps', async () => {
      const d = await repo.register({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        platform: 'ios',
        token: 'A-tok-1',
      });
      expect(d.id).toBeTruthy();
      expect(d.createdAt).toBeInstanceOf(Date);
      expect(d.updatedAt).toBeInstanceOf(Date);
      expect(d.lastSeenAt).toBeInstanceOf(Date);
      const list = await repo.listByTenant(tenantA.tenantId);
      expect(list.map((r) => r.token)).toContain('A-tok-1');
    });

    it('upserts on (tenant, token): re-register updates platform, no duplicate row', async () => {
      await repo.register({ tenantId: tenantA.tenantId, userId: tenantA.userId, platform: 'ios', token: 'A-up' });
      await repo.register({ tenantId: tenantA.tenantId, userId: tenantA.userId, platform: 'android', token: 'A-up' });
      const rows = (await repo.listByTenant(tenantA.tenantId)).filter((r) => r.token === 'A-up');
      expect(rows).toHaveLength(1);
      expect(rows[0].platform).toBe('android');
    });

    it('allows the same token string under two tenants (unique is per (tenant, token))', async () => {
      await repo.register({ tenantId: tenantA.tenantId, userId: tenantA.userId, platform: 'ios', token: 'dual' });
      await repo.register({ tenantId: tenantB.tenantId, userId: tenantB.userId, platform: 'ios', token: 'dual' });
      expect((await repo.listByTenant(tenantA.tenantId)).filter((r) => r.token === 'dual')).toHaveLength(1);
      expect((await repo.listByTenant(tenantB.tenantId)).filter((r) => r.token === 'dual')).toHaveLength(1);
    });

    it('deleteToken removes the token and reports removal', async () => {
      await repo.register({ tenantId: tenantA.tenantId, userId: tenantA.userId, platform: 'ios', token: 'del' });
      expect(await repo.deleteToken(tenantA.tenantId, 'del')).toBe(true);
      expect((await repo.listByTenant(tenantA.tenantId)).map((r) => r.token)).not.toContain('del');
      expect(await repo.deleteToken(tenantA.tenantId, 'del')).toBe(false);
    });
  });

  describe('RLS isolation (unprivileged role)', () => {
    beforeAll(async () => {
      await repo.register({ tenantId: tenantA.tenantId, userId: tenantA.userId, platform: 'ios', token: 'iso-A' });
      await repo.register({ tenantId: tenantB.tenantId, userId: tenantB.userId, platform: 'ios', token: 'iso-B' });
    });

    it('a tenant sees only its own device tokens', async () => {
      const aTokens = await asTenant(pool, tenantA.tenantId, async (c) => {
        const r = await c.query<{ token: string }>('SELECT token FROM device_tokens');
        return r.rows.map((row) => row.token);
      });
      expect(aTokens).toContain('iso-A');
      expect(aTokens).not.toContain('iso-B');
    });

    it('switching tenant context flips visibility — no bleed', async () => {
      const bTokens = await asTenant(pool, tenantB.tenantId, async (c) => {
        const r = await c.query<{ token: string }>('SELECT token FROM device_tokens');
        return r.rows.map((row) => row.token);
      });
      expect(bTokens).toContain('iso-B');
      expect(bTokens).not.toContain('iso-A');
    });

    it('an unknown tenant context sees nothing', async () => {
      const count = await asTenant(pool, crypto.randomUUID(), async (c) => {
        const r = await c.query('SELECT token FROM device_tokens');
        return r.rows.length;
      });
      expect(count).toBe(0);
    });

    it('cannot INSERT a token attributed to another tenant (WITH CHECK)', async () => {
      await expect(
        asTenant(pool, tenantA.tenantId, async (c) => {
          await c.query(
            `INSERT INTO device_tokens (tenant_id, user_id, platform, token) VALUES ($1, $2, $3, $4)`,
            [tenantB.tenantId, tenantB.userId, 'ios', 'forged'],
          );
        }),
      ).rejects.toThrow(/row-level security/i);
    });
  });
});
