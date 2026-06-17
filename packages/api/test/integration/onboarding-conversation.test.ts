import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgOnboardingSessionRepository } from '../../src/db/onboarding-session-repository';

describe('onboarding_session — integration', () => {
  let pool: Pool;
  let repo: PgOnboardingSessionRepository;
  let tenant: { tenantId: string; userId: string };
  let secondTenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgOnboardingSessionRepository(pool);
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

  it('RLS prevents cross-tenant reads — tenant B cannot see tenant A session', async () => {
    const aSession = await repo.create(tenant.tenantId);
    // Wrapping the query in the OTHER tenant's withTenant context must
    // return null. PgBaseRepository.withTenant SETs current_tenant_id,
    // and the RLS policy on onboarding_session filters by it.
    const visible = await repo.findById(secondTenant.tenantId, aSession.id);
    expect(visible).toBeNull();
    // And the owning tenant still sees the row.
    const owned = await repo.findById(tenant.tenantId, aSession.id);
    expect(owned).not.toBeNull();
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
