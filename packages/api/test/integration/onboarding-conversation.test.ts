import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgOnboardingSessionRepository } from '../../src/db/onboarding-session-repository';

/**
 * Cross-tenant isolation is meaningless under the testcontainer's default
 * SUPERUSER role: superusers bypass RLS unconditionally (FORCE or not). To
 * actually exercise the policy on `onboarding_session` we mirror
 * `rls-tenant-isolation.test.ts`'s pattern — connect as the unprivileged
 * `rls_app_runtime` role (NOBYPASSRLS) and SET LOCAL the tenant GUC.
 */
const APP_ROLE = 'rls_app_runtime';
async function asTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
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

describe('onboarding_session — integration', () => {
  let pool: Pool;
  let repo: PgOnboardingSessionRepository;
  let tenant: { tenantId: string; userId: string };
  let secondTenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgOnboardingSessionRepository(pool);
    // Idempotently provision the unprivileged role + grants used by the
    // RLS test below. Mirrors rls-tenant-isolation.test.ts so the tests
    // can run in any order against the shared container.
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} NOLOGIN NOBYPASSRLS;
      END IF;
    END $$;`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
  });

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
    secondTenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('creates a session with the migration-defined defaults', async () => {
    const session = await repo.create(tenant.tenantId);
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.tenantId).toBe(tenant.tenantId);
    expect(session.fsmState).toBe('profile_capture');
    expect(session.transcriptTurns).toEqual([]);
    expect(session.pendingClarifications).toEqual([]);
    expect(session.clarificationCountByState).toEqual({});
    expect(session.extractions).toEqual({});
    expect(session.turnCount).toBe(0);
    expect(session.proposalBatchIds).toEqual([]);
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.completedAt).toBeUndefined();
  });

  it('round-trips transcript turns + extractions + clarification counts via JSONB columns', async () => {
    const session = await repo.create(tenant.tenantId);
    const updated = await repo.update(tenant.tenantId, session.id, {
      fsmState: 'category_capture',
      transcriptTurns: [
        { role: 'user', text: 'plumbing', at: '2026-06-17T15:00:00Z', state: 'profile_capture' },
        { role: 'assistant', text: 'got it', at: '2026-06-17T15:00:05Z', state: 'category_capture' },
      ],
      pendingClarifications: ['What categories?'],
      clarificationCountByState: { profile_capture: 1 },
      extractions: {
        businessProfile: {
          businessName: 'Acme',
          city: 'Phoenix',
          state: 'AZ',
          verticalPacks: [],
          serviceDescriptions: [],
          confidence: 0.8,
          lowConfidenceFields: [],
        },
      },
      turnCount: 1,
    });
    expect(updated).not.toBeNull();
    expect(updated!.fsmState).toBe('category_capture');
    expect(updated!.transcriptTurns).toHaveLength(2);
    expect(updated!.transcriptTurns[0].text).toBe('plumbing');
    expect(updated!.pendingClarifications).toEqual(['What categories?']);
    expect(updated!.clarificationCountByState.profile_capture).toBe(1);
    expect(updated!.extractions.businessProfile?.businessName).toBe('Acme');
    expect(updated!.turnCount).toBe(1);
  });

  it('migration 195 pins ENABLE + FORCE row-level security and the tenant_isolation policy', async () => {
    // Catches a future in-place edit that quietly drops FORCE or the
    // policy. The application-layer RLS test below is hidden by the
    // superuser default — this pg_catalog assertion isn't.
    const cls = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE relname = 'onboarding_session'`,
    );
    expect(cls.rows[0].relrowsecurity).toBe(true);
    expect(cls.rows[0].relforcerowsecurity).toBe(true);

    const policies = await pool.query<{ policyname: string; qual: string }>(
      `SELECT policyname, qual FROM pg_policies WHERE tablename = 'onboarding_session'`,
    );
    expect(policies.rows.length).toBeGreaterThan(0);
    expect(policies.rows[0].policyname).toBe('tenant_isolation_onboarding_session');
    expect(policies.rows[0].qual).toContain('app.current_tenant_id');
  });

  it('RLS prevents cross-tenant reads under the unprivileged app role', async () => {
    // Insert as the superuser (fixture-friendly, bypasses RLS), then
    // SELECT under the rls_app_runtime role with tenant B's GUC.
    const aSession = await repo.create(tenant.tenantId);

    const visibleToB = await asTenant(pool, secondTenant.tenantId, async (c) => {
      const r = await c.query<{ id: string }>(
        'SELECT id FROM onboarding_session WHERE id = $1',
        [aSession.id],
      );
      return r.rows;
    });
    expect(visibleToB).toEqual([]);

    const visibleToA = await asTenant(pool, tenant.tenantId, async (c) => {
      const r = await c.query<{ id: string }>(
        'SELECT id FROM onboarding_session WHERE id = $1',
        [aSession.id],
      );
      return r.rows;
    });
    expect(visibleToA.length).toBe(1);
  });

  it('the partial index supports the cross-tenant created_at DESC ordering used by status listings', async () => {
    // Sanity check that the index migration parsed and the column types
    // accept the expected predicates. We don't assert on EXPLAIN plans
    // (those are version-sensitive); a successful query is enough.
    const a = await repo.create(tenant.tenantId);
    const b = await repo.create(tenant.tenantId);
    const result = await pool.query(
      `SELECT id FROM onboarding_session WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [tenant.tenantId],
    );
    const ids = result.rows.map((r: { id: string }) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it('marks the session completed when completedAt is set', async () => {
    const session = await repo.create(tenant.tenantId);
    const completedAt = new Date('2026-06-17T16:00:00Z');
    const updated = await repo.update(tenant.tenantId, session.id, {
      fsmState: 'completed',
      completedAt,
    });
    expect(updated?.fsmState).toBe('completed');
    expect(updated?.completedAt?.toISOString()).toBe(completedAt.toISOString());
  });
});
