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
});
