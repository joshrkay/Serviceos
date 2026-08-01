import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgStandingInstructionRepository } from '../../src/instructions/pg-standing-instructions';
import {
  MAX_ACTIVE_STANDING_INSTRUCTIONS,
  StandingInstructionLimitError,
  createStandingInstruction,
} from '../../src/instructions/standing-instructions';

const APP_ROLE = 'rls_app_runtime';

/**
 * Unprivileged-role tenant context — same helper as rls-tenant-isolation.test.ts.
 * The testcontainer superuser bypasses RLS, so genuine policy enforcement is
 * only observable through a NOBYPASSRLS role.
 */
async function asTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('Postgres integration — standing instructions (migration 229)', () => {
  let pool: Pool;
  let repo: PgStandingInstructionRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgStandingInstructionRepository(pool);
    tenant = await createTestTenant(pool);

    // Idempotent unprivileged role for the DB-level RLS assertion (mirrors
    // rls-tenant-isolation.test.ts — safe if that file already created it).
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} NOLOGIN NOBYPASSRLS;
      END IF;
    END $$;`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists an instruction pinning real column names and JSONB scope round-trip', async () => {
    const created = await createStandingInstruction(
      {
        tenantId: tenant.tenantId,
        instruction: 'Always add a fuel surcharge',
        scope: {
          intents: ['create_estimate'],
          tradeCategories: ['hvac'],
          customerSegment: 'new',
          amountCents: 5000,
        },
        source: 'settings',
        createdBy: tenant.userId,
      },
      repo
    );

    const { rows } = await pool.query(
      `SELECT id, tenant_id, instruction, scope, active, source, created_by,
              created_at, updated_at, deactivated_at, deactivated_by
         FROM standing_instructions WHERE id = $1`,
      [created.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenant.tenantId);
    expect(rows[0].instruction).toBe('Always add a fuel surcharge');
    expect(rows[0].scope).toEqual({
      intents: ['create_estimate'],
      tradeCategories: ['hvac'],
      customerSegment: 'new',
      amountCents: 5000,
    });
    expect(rows[0].active).toBe(true);
    expect(rows[0].source).toBe('settings');
    expect(rows[0].created_by).toBe(tenant.userId);
    expect(rows[0].deactivated_at).toBeNull();
    expect(rows[0].deactivated_by).toBeNull();
  });

  it('rejects sources outside proposal|settings at the DB layer (CHECK)', async () => {
    await expect(
      pool.query(
        `INSERT INTO standing_instructions (tenant_id, instruction, source, created_by)
         VALUES ($1, 'x', 'voice', $2)`,
        [tenant.tenantId, tenant.userId]
      )
    ).rejects.toThrow(/check constraint/i);
  });

  it('lists newest first, filters active, and stamps deactivation columns', async () => {
    const scoped = await createTestTenant(pool);
    const older = await createStandingInstruction(
      { tenantId: scoped.tenantId, instruction: 'Older rule', source: 'settings', createdBy: scoped.userId },
      repo
    );
    // Distinct created_at so the ORDER BY is actually exercised.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await createStandingInstruction(
      { tenantId: scoped.tenantId, instruction: 'Newer rule', source: 'proposal', createdBy: scoped.userId },
      repo
    );

    expect((await repo.listAll(scoped.tenantId)).map((i) => i.id)).toEqual([newer.id, older.id]);

    const deactivated = await repo.deactivate(scoped.tenantId, older.id, scoped.userId);
    expect(deactivated?.active).toBe(false);

    expect((await repo.listActive(scoped.tenantId)).map((i) => i.id)).toEqual([newer.id]);
    expect((await repo.listAll(scoped.tenantId)).map((i) => i.id)).toEqual([newer.id, older.id]);

    const { rows } = await pool.query(
      `SELECT active, deactivated_at, deactivated_by FROM standing_instructions WHERE id = $1`,
      [older.id]
    );
    expect(rows[0].active).toBe(false);
    expect(rows[0].deactivated_at).not.toBeNull();
    expect(rows[0].deactivated_by).toBe(scoped.userId);

    // Deactivating again is a no-op at the repo layer (already inactive).
    expect(await repo.deactivate(scoped.tenantId, older.id, scoped.userId)).toBeNull();
  });

  it('does not leak instructions across tenants through the repo API', async () => {
    const created = await createStandingInstruction(
      { tenantId: tenant.tenantId, instruction: 'Secret directive', source: 'settings', createdBy: tenant.userId },
      repo
    );
    const other = await createTestTenant(pool);
    expect(await repo.findById(other.tenantId, created.id)).toBeNull();
    expect(await repo.listAll(other.tenantId)).toEqual([]);
    expect(await repo.deactivate(other.tenantId, created.id, other.userId)).toBeNull();
  });

  it('enforces RLS at the DB level — tenant B cannot read tenant A rows', async () => {
    const created = await createStandingInstruction(
      { tenantId: tenant.tenantId, instruction: 'RLS-guarded directive', source: 'settings', createdBy: tenant.userId },
      repo
    );
    const other = await createTestTenant(pool);

    // Unscoped SELECT (no WHERE) as tenant B through the unprivileged role:
    // the policy itself must hide tenant A's row.
    const visibleToB = await asTenant(pool, other.tenantId, async (client) => {
      const r = await client.query<{ id: string }>('SELECT id FROM standing_instructions');
      return r.rows.map((row) => row.id);
    });
    expect(visibleToB).not.toContain(created.id);

    const visibleToA = await asTenant(pool, tenant.tenantId, async (client) => {
      const r = await client.query<{ id: string }>('SELECT id FROM standing_instructions');
      return r.rows.map((row) => row.id);
    });
    expect(visibleToA).toContain(created.id);
  });

  it('enforces the 20-active cap inside the real insert transaction', async () => {
    const capped = await createTestTenant(pool);
    for (let i = 0; i < MAX_ACTIVE_STANDING_INSTRUCTIONS; i++) {
      await createStandingInstruction(
        { tenantId: capped.tenantId, instruction: `Rule ${i}`, source: 'settings', createdBy: capped.userId },
        repo
      );
    }

    await expect(
      createStandingInstruction(
        { tenantId: capped.tenantId, instruction: 'One too many', source: 'settings', createdBy: capped.userId },
        repo
      )
    ).rejects.toBeInstanceOf(StandingInstructionLimitError);

    // The rejected create must not have left a row behind (transactional).
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM standing_instructions WHERE tenant_id = $1`,
      [capped.tenantId]
    );
    expect(rows[0].n).toBe(MAX_ACTIVE_STANDING_INSTRUCTIONS);

    // Deactivating one frees a slot.
    const victim = (await repo.listActive(capped.tenantId))[0];
    await repo.deactivate(capped.tenantId, victim.id, capped.userId);
    await expect(
      createStandingInstruction(
        { tenantId: capped.tenantId, instruction: 'Fits now', source: 'settings', createdBy: capped.userId },
        repo
      )
    ).resolves.toBeTruthy();
  });

  it('applies DB defaults declared in migration 229 (id, scope, active, timestamps)', async () => {
    const { rows } = await pool.query(
      `INSERT INTO standing_instructions (tenant_id, instruction, source, created_by)
       VALUES ($1, 'Defaults only', 'settings', $2)
       RETURNING id, scope, active, created_at, updated_at`,
      [tenant.tenantId, tenant.userId]
    );
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0].scope).toEqual({});
    expect(rows[0].active).toBe(true);
    expect(rows[0].created_at).not.toBeNull();
    expect(rows[0].updated_at).not.toBeNull();
  });
});
