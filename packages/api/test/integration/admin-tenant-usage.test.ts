/**
 * Docker-gated integration test — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration` (or an
 * EXTERNAL_TEST_DB_URL with the full schema applied).
 *
 * Pins PgTenantUsageRepository (platform-admin GET
 * /api/admin/tenants/:tenantId/usage) against REAL Postgres: the exact column
 * names it aggregates over (ai_runs.token_usage/cost_micro_cents,
 * call_usage_events.ended_at/billable/duration_seconds,
 * ai_voice_usage_costs.provider_cost_micro_cents/occurred_at,
 * audit_events.event_type/created_at, users.deleted_at, tenants.plan_id/
 * subscription_status), [from, to) window filtering, and zero leakage from a
 * second tenant — including when the call happens inside ANOTHER tenant's
 * request-scoped transaction (the platform admin's own tenant).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { PgTenantUsageRepository } from '../../src/admin/pg-tenant-usage';
import { tenantContextStore } from '../../src/middleware/tenant-context';
import { applyTenantContext, clearTenantContext } from '../../src/db/rls-runtime-role';

const FROM = new Date('2026-09-01T00:00:00.000Z');
const TO = new Date('2026-10-01T00:00:00.000Z');
const IN = (day: number) => new Date(Date.UTC(2026, 8, day, 12)); // Sept `day`, inside window
const BEFORE = new Date('2026-08-31T23:59:59.000Z');
const AT_TO = TO; // exclusive upper bound — must NOT count

describe('Postgres integration — platform-admin tenant usage report', () => {
  let pool: Pool;
  let repo: PgTenantUsageRepository;
  let a: TestTenant;
  let b: TestTenant;

  async function aiRun(
    tenantId: string,
    taskType: string,
    createdAt: Date,
    opts: { status?: string; input?: number; output?: number; cost?: number | null } = {},
  ): Promise<void> {
    await pool.query(
      `INSERT INTO ai_runs (tenant_id, task_type, model, status, token_usage, cost_micro_cents,
                            created_by, created_at)
       VALUES ($1, $2, 'claude-sonnet-4-6', $3, $4, $5, 'test', $6)`,
      [
        tenantId,
        taskType,
        opts.status ?? 'completed',
        JSON.stringify({
          input: opts.input ?? 0,
          output: opts.output ?? 0,
          total: (opts.input ?? 0) + (opts.output ?? 0),
        }),
        opts.cost === undefined ? 0 : opts.cost,
        createdAt,
      ],
    );
  }

  async function call(
    tenantId: string,
    endedAt: Date,
    seconds: number,
    billable: boolean,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO call_usage_events (tenant_id, call_id, started_at, ended_at, duration_seconds,
                                      billable, not_billable_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        tenantId,
        `call-${crypto.randomUUID()}`,
        new Date(endedAt.getTime() - seconds * 1000),
        endedAt,
        seconds,
        billable,
        billable ? null : 'under_threshold',
      ],
    );
  }

  async function voiceCost(
    tenantId: string,
    provider: string,
    microCents: number,
    occurredAt: Date,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO ai_voice_usage_costs (id, tenant_id, session_id, source_id, provider,
                                         usage_seconds, provider_cost_micro_cents, occurred_at)
       VALUES ($1, $2, 'sess-1', $3, $4, 60, $5, $6)`,
      [crypto.randomUUID(), tenantId, crypto.randomUUID(), provider, microCents, occurredAt],
    );
  }

  async function audit(tenantId: string, eventType: string, createdAt: Date): Promise<void> {
    await pool.query(
      `INSERT INTO audit_events (tenant_id, actor_id, actor_role, event_type, entity_type,
                                 entity_id, created_at)
       VALUES ($1, 'actor', 'owner', $2, 'job', 'job-1', $3)`,
      [tenantId, eventType, createdAt],
    );
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgTenantUsageRepository(pool);
    a = await createTestTenant(pool);
    b = await createTestTenant(pool);
    await pool.query(
      `UPDATE tenants SET name = 'Tenant A', plan_id = 'growth', subscription_status = 'active'
        WHERE id = $1`,
      [a.tenantId],
    );
    // A second live user and a soft-deleted one for tenant A.
    await pool.query(
      `INSERT INTO users (tenant_id, clerk_user_id, email, role, deleted_at)
       VALUES ($1, $2, 'tech@example.com', 'technician', NULL),
              ($1, $3, 'gone@example.com', 'technician', NOW())`,
      [a.tenantId, `clerk-${crypto.randomUUID()}`, `clerk-${crypto.randomUUID()}`],
    );

    // ── Tenant A: inside the window ──
    await aiRun(a.tenantId, 'draft_estimate', IN(2), { input: 100, output: 20, cost: 1_000_000 });
    await aiRun(a.tenantId, 'draft_estimate', IN(3), { input: 50, output: 5, cost: 500_000, status: 'failed' });
    await aiRun(a.tenantId, 'classify_intent', IN(4), { input: 10, output: 1, cost: null });
    await call(a.tenantId, IN(5), 61, true);
    await call(a.tenantId, IN(6), 45, true);
    await call(a.tenantId, IN(7), 5, false);
    await voiceCost(a.tenantId, 'twilio', 700, IN(5));
    await voiceCost(a.tenantId, 'stt', 300, IN(5));
    await voiceCost(a.tenantId, 'twilio', 200, IN(6));
    await audit(a.tenantId, 'job.created', IN(8));
    await audit(a.tenantId, 'job.created', IN(9));
    await audit(a.tenantId, 'invoice.sent', IN(10));

    // ── Tenant A: outside the window (before `from`, and exactly at `to`) ──
    for (const at of [BEFORE, AT_TO]) {
      await aiRun(a.tenantId, 'draft_estimate', at, { input: 9_999, output: 9_999, cost: 9_999_999 });
      await call(a.tenantId, at, 600, true);
      await voiceCost(a.tenantId, 'twilio', 9_999, at);
    }
    await audit(a.tenantId, 'job.created', BEFORE);
    await audit(a.tenantId, 'job.created', AT_TO);

    // ── Tenant B: same window, large numbers that must never leak into A ──
    await aiRun(b.tenantId, 'draft_estimate', IN(2), { input: 1_000_000, output: 1_000_000, cost: 77_000_000 });
    await call(b.tenantId, IN(5), 3_600, true);
    await voiceCost(b.tenantId, 'tts', 55_555, IN(5));
    await audit(b.tenantId, 'tenant_b.only_event', IN(8));
  }, 120_000);

  afterAll(async () => {
    for (const t of [a, b]) {
      if (!t) continue;
      await pool.query('DELETE FROM ai_runs WHERE tenant_id = $1', [t.tenantId]);
      await pool.query('DELETE FROM call_usage_events WHERE tenant_id = $1', [t.tenantId]);
      await pool.query('DELETE FROM ai_voice_usage_costs WHERE tenant_id = $1', [t.tenantId]);
      await pool.query('DELETE FROM audit_events WHERE tenant_id = $1', [t.tenantId]);
    }
    await closeSharedTestDb();
  });

  it('returns null for an unknown tenant', async () => {
    expect(await repo.getUsage(crypto.randomUUID(), { from: FROM, to: TO })).toBeNull();
  });

  it('aggregates tenant A over [from, to) with no leakage from tenant B', async () => {
    const r = await repo.getUsage(a.tenantId, { from: FROM, to: TO });
    expect(r).not.toBeNull();

    expect(r!.tenant).toMatchObject({
      id: a.tenantId,
      name: 'Tenant A',
      planId: 'growth',
      subscriptionStatus: 'active',
    });
    expect(r!.tenant.createdAt).toMatch(/Z$/);
    expect(r!.window).toEqual({ from: FROM.toISOString(), to: TO.toISOString() });

    expect(r!.ai.totals).toEqual({
      runs: 3,
      failedRuns: 1,
      inputTokens: 160,
      outputTokens: 26,
      costMicroCents: 1_500_000,
      unpricedRuns: 1,
    });
    expect(r!.ai.byTaskType).toEqual([
      {
        taskType: 'draft_estimate',
        runs: 2,
        failedRuns: 1,
        inputTokens: 150,
        outputTokens: 25,
        costMicroCents: 1_500_000,
        unpricedRuns: 0,
      },
      {
        taskType: 'classify_intent',
        runs: 1,
        failedRuns: 0,
        inputTokens: 10,
        outputTokens: 1,
        costMicroCents: 0,
        unpricedRuns: 1,
      },
    ]);

    expect(r!.voice).toEqual({
      calls: 3,
      billableCalls: 2,
      billableSeconds: 106,
      billableMinutes: 2,
      providerCostMicroCents: {
        total: 1_200,
        byProvider: [
          { provider: 'stt', costMicroCents: 300 },
          { provider: 'twilio', costMicroCents: 900 },
        ],
      },
    });

    expect(r!.activity).toEqual({
      auditEventCount: 3,
      // Newest event strictly before `to` — the BEFORE row is older, the
      // AT_TO row is excluded.
      lastActivityAt: IN(10).toISOString(),
      topEventTypes: [
        { eventType: 'job.created', count: 2 },
        { eventType: 'invoice.sent', count: 1 },
      ],
    });

    // createTestTenant's owner + the live technician; the soft-deleted one is excluded.
    expect(r!.users).toEqual({ count: 2 });
  });

  it('returns zeros for a window with no data (and integer types throughout)', async () => {
    const r = await repo.getUsage(a.tenantId, {
      from: new Date('2020-01-01T00:00:00Z'),
      to: new Date('2020-02-01T00:00:00Z'),
    });
    expect(r!.ai.totals).toEqual({
      runs: 0,
      failedRuns: 0,
      inputTokens: 0,
      outputTokens: 0,
      costMicroCents: 0,
      unpricedRuns: 0,
    });
    expect(r!.ai.byTaskType).toEqual([]);
    expect(r!.voice.providerCostMicroCents).toEqual({ total: 0, byProvider: [] });
    expect(r!.voice.calls).toBe(0);
    expect(r!.activity).toEqual({ auditEventCount: 0, lastActivityAt: null, topEventTypes: [] });
  });

  it("reads the TARGET tenant even inside another tenant's request transaction", async () => {
    // Simulate the platform admin's own request: the /api middleware put a
    // client scoped to tenant B in the store. The usage read for tenant A
    // must not reuse it (it would see B's rows / none of A's under RLS).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await applyTenantContext(client, b.tenantId, { transactional: true });
      const r = await tenantContextStore.run({ client, tenantId: b.tenantId }, () =>
        repo.getUsage(a.tenantId, { from: FROM, to: TO }),
      );
      expect(r!.tenant.id).toBe(a.tenantId);
      expect(r!.ai.totals.costMicroCents).toBe(1_500_000);
      expect(r!.voice.providerCostMicroCents.total).toBe(1_200);
      expect(r!.activity.topEventTypes.map((t) => t.eventType)).not.toContain(
        'tenant_b.only_event',
      );
      await client.query('ROLLBACK');
    } finally {
      await clearTenantContext(client);
      client.release();
    }
  });

  it('reports tenant B on its own without tenant A rows', async () => {
    const r = await repo.getUsage(b.tenantId, { from: FROM, to: TO });
    expect(r!.ai.totals).toMatchObject({ runs: 1, inputTokens: 1_000_000, costMicroCents: 77_000_000 });
    expect(r!.voice).toMatchObject({ calls: 1, billableSeconds: 3_600, billableMinutes: 60 });
    expect(r!.voice.providerCostMicroCents.byProvider).toEqual([
      { provider: 'tts', costMicroCents: 55_555 },
    ]);
    expect(r!.activity.topEventTypes).toEqual([{ eventType: 'tenant_b.only_event', count: 1 }]);
    expect(r!.users).toEqual({ count: 1 });
  });
});
