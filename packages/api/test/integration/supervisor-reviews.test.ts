/**
 * N-004 (P2-037) — Postgres integration for the Supervisor Agent review pass.
 *
 * Mocked-DB unit tests (reviewer.test.ts) prove the verdict/hold/marker logic;
 * this pins the REAL schema: migration 242 columns + RLS isolation on
 * supervisor_reviews, the ai_run_id FK, and the inline rolling-average query
 * against real estimates.total_cents / invoices.total_cents columns (the
 * entity-resolver lesson: a mocked Pool once shipped nonexistent column names).
 *
 * FK-PATH-COVERAGE: src/ai/supervisor/reviews-repo.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSupervisorReviewRepository } from '../../src/ai/supervisor/reviews-repo';
import { PgPricingBaselineResolver } from '../../src/ai/supervisor/pricing-baseline';

async function seedProposal(pool: Pool, tenantId: string, createdBy: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO proposals (id, tenant_id, proposal_type, status, payload, idempotency_key, created_by)
     VALUES ($1, $2, 'draft_estimate', 'ready_for_review', '{}'::jsonb, $3, $4)`,
    [id, tenantId, `idem-${id}`, createdBy],
  );
  return id;
}

async function seedAiRun(pool: Pool, tenantId: string, createdBy: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO ai_runs (id, tenant_id, task_type, model, status, created_by)
     VALUES ($1, $2, 'supervisor_review', 'claude-haiku-4-5-20251001', 'completed', $3)`,
    [id, tenantId, createdBy],
  );
  return id;
}

async function seedJobs(
  pool: Pool,
  tenantId: string,
  createdBy: string,
  count: number,
): Promise<string[]> {
  const customerId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, display_name, created_by) VALUES ($1, $2, $3, $4)`,
    [customerId, tenantId, 'Baseline Co', createdBy],
  );
  const locationId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code)
     VALUES ($1, $2, $3, '1 Main', 'Town', 'CA', '90000')`,
    [locationId, tenantId, customerId],
  );
  const jobIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const jobId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, created_by)
       VALUES ($1, $2, $3, $4, $5, 'Job', $6)`,
      [jobId, tenantId, customerId, locationId, `J-${jobId.slice(0, 8)}`, createdBy],
    );
    jobIds.push(jobId);
  }
  return jobIds;
}

describe('Postgres integration — supervisor_reviews (migration 242)', () => {
  let pool: Pool;
  let repo: PgSupervisorReviewRepository;
  let baselineResolver: PgPricingBaselineResolver;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgSupervisorReviewRepository(pool);
    baselineResolver = new PgPricingBaselineResolver(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists every column and links a real ai_run_id FK', async () => {
    const proposalId = await seedProposal(pool, tenant.tenantId, tenant.userId);
    const aiRunId = await seedAiRun(pool, tenant.tenantId, tenant.userId);

    const created = await repo.create({
      tenantId: tenant.tenantId,
      proposalId,
      aiRunId,
      model: 'claude-haiku-4-5-20251001',
      verdict: 'hold',
      critical: true,
      checks: { missed_urgency: { verdict: 'critical', reason: 'medical mention' } },
      flags: ['unescalated medical mention'],
      latencyMs: 1234,
      shadow: false,
    });

    expect(created.id).toBeTruthy();
    const found = await repo.findByProposal(tenant.tenantId, proposalId);
    expect(found).toHaveLength(1);
    expect(found[0].verdict).toBe('hold');
    expect(found[0].critical).toBe(true);
    expect(found[0].aiRunId).toBe(aiRunId);
    expect(found[0].flags).toContain('unescalated medical mention');
    expect(found[0].latencyMs).toBe(1234);
    expect(found[0].shadow).toBe(false);
    expect((found[0].checks as Record<string, unknown>).missed_urgency).toBeTruthy();
  });

  it('allows a deterministic-only review with a null ai_run_id', async () => {
    const proposalId = await seedProposal(pool, tenant.tenantId, tenant.userId);
    const created = await repo.create({
      tenantId: tenant.tenantId,
      proposalId,
      aiRunId: null,
      model: 'claude-haiku-4-5-20251001',
      verdict: 'flag',
      critical: false,
      checks: { pricing_anomaly: { verdict: 'flag' } },
      flags: ['30% above avg'],
      shadow: true,
    });
    expect(created.aiRunId).toBeNull();
  });

  it('RLS isolates supervisor_reviews across tenants', async () => {
    const other = await createTestTenant(pool);
    const proposalId = await seedProposal(pool, other.tenantId, other.userId);
    await repo.create({
      tenantId: other.tenantId,
      proposalId,
      model: 'm',
      verdict: 'pass',
      critical: false,
      checks: {},
      flags: [],
      shadow: true,
    });
    // Reading under `tenant`'s RLS context must NOT see `other`'s review.
    const leaked = await repo.findByProposal(tenant.tenantId, proposalId);
    expect(leaked).toHaveLength(0);
  });

  it('computes the rolling-average baseline from accepted estimates + paid invoices', async () => {
    const t = await createTestTenant(pool);
    // One accepted estimate per job (uq_estimates_accepted_per_job), so use
    // distinct jobs for the two accepted estimates + the rejected one.
    const [j1, j2, j3] = await seedJobs(pool, t.tenantId, t.userId, 3);
    // Accepted estimates (10000, 12000) + paid invoice (14000) → avg 12000, n=3.
    // A rejected estimate + a void invoice must be EXCLUDED.
    await pool.query(
      `INSERT INTO estimates (tenant_id, job_id, estimate_number, status, total_cents, created_by)
       VALUES ($1,$2,'E1','accepted',10000,$5),($1,$3,'E2','accepted',12000,$5),($1,$4,'E3','rejected',99999,$5)`,
      [t.tenantId, j1, j2, j3, t.userId],
    );
    await pool.query(
      `INSERT INTO invoices (tenant_id, job_id, invoice_number, status, total_cents, created_by)
       VALUES ($1,$2,'I1','paid',14000,$3),($1,$2,'I2','void',88888,$3)`,
      [t.tenantId, j1, t.userId],
    );

    const baseline = await baselineResolver.resolve(t.tenantId);
    expect(baseline.sampleSize).toBe(3);
    expect(baseline.avgCents).toBe(12000);
  });

  describe('findForDay (WS6 digest reflection)', () => {
    it('returns reviews in [from, to), newest first, capped at limit, scoped to the tenant (RLS)', async () => {
      const t = await createTestTenant(pool);
      const p1 = await seedProposal(pool, t.tenantId, t.userId);
      const p2 = await seedProposal(pool, t.tenantId, t.userId);
      const p3 = await seedProposal(pool, t.tenantId, t.userId);

      // Three reviews on the target day (one flagged, one held, one pass) +
      // one review outside the window (yesterday) that must not be counted.
      await repo.create({
        tenantId: t.tenantId,
        proposalId: p1,
        model: 'm',
        verdict: 'pass',
        critical: false,
        checks: {},
        flags: [],
        shadow: true,
      });
      await repo.create({
        tenantId: t.tenantId,
        proposalId: p2,
        model: 'm',
        verdict: 'flag',
        critical: false,
        checks: {},
        flags: ['30% above avg'],
        shadow: true,
      });
      await repo.create({
        tenantId: t.tenantId,
        proposalId: p3,
        model: 'm',
        verdict: 'hold',
        critical: true,
        checks: {},
        flags: ['unescalated medical mention'],
        shadow: false,
      });

      // Push one review's created_at outside today's window (simulates
      // "yesterday") — mirrors the pattern the confidence-marked proposal
      // integration coverage uses for day-window pinning.
      await pool.query(
        `UPDATE supervisor_reviews SET created_at = now() - interval '2 days' WHERE proposal_id = $1`,
        [p1],
      );

      const from = new Date(Date.now() - 6 * 60 * 60 * 1000); // 6h ago
      const to = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6h from now

      const found = await repo.findForDay(t.tenantId, from, to);
      expect(found.map((r) => r.proposalId).sort()).toEqual([p2, p3].sort());
      expect(found.every((r) => r.tenantId === t.tenantId)).toBe(true);

      const capped = await repo.findForDay(t.tenantId, from, to, 1);
      expect(capped).toHaveLength(1);

      // RLS isolation: another tenant never sees these rows.
      const other = await createTestTenant(pool);
      const leaked = await repo.findForDay(other.tenantId, from, to);
      expect(leaked).toHaveLength(0);
    });
  });
});
