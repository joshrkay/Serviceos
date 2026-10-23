/**
 * Postgres integration — the durable shadow-comparison store (P2-030) against
 * the REAL schema.
 *
 * `PgShadowComparisonStore` reached main (#1615) without its table: migration
 * `101_create_shadow_comparisons` stayed on its feature branch (101 went to
 * `101_google_reviews`), so with `SHADOW_LLM_ENABLED=true` and a pool
 * (app.ts) every SAMPLED LLM call's `save()` hit 42P01 and
 * `ShadowComparisonGateway.complete` rejected — after the primary call had
 * already succeeded. Inside a request, `save()` runs on the ambient request
 * client (PgBaseRepository reuse), so the failed INSERT also aborted the
 * whole request transaction. The store's unit tests mock the Pool, so none of
 * that was visible; this file executes every statement for real.
 *
 * It pins: a sampled call through the gateway persists and returns the
 * primary response; a sampled call inside an open tenant transaction leaves
 * that transaction usable; and the store's read is tenant-bounded with the
 * RLS runtime role on and off (`listForTenant` filters `tenant_id = $1`, and
 * the table is ENABLE + FORCE RLS).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { PgShadowComparisonStore } from '../../src/ai/evaluation/pg-shadow-comparison';
import {
  ShadowComparisonGateway,
  type ShadowComparisonResult,
} from '../../src/ai/evaluation/shadow-comparison';
import { StubProvider } from '../../src/ai/gateway/providers';
import { applyTenantContext } from '../../src/db/rls-runtime-role';
import { tenantContextStore } from '../../src/middleware/tenant-context';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;

let pool: Pool;
let store: PgShadowComparisonStore;
const createdTenantIds: string[] = [];

async function seedTenant(): Promise<{ tenantId: string; userId: string }> {
  const tenant = await createTestTenant(pool);
  createdTenantIds.push(tenant.tenantId);
  return tenant;
}

function sampledGateway(): ShadowComparisonGateway {
  const primary = new StubProvider('primary');
  primary.setResponse({ content: 'primary answer for jo@example.com' });
  const shadow = new StubProvider('shadow');
  shadow.setResponse({ content: 'shadow answer' });
  // sampleFn 0 < samplingRate 1: every call is sampled.
  return new ShadowComparisonGateway(primary, shadow, store, {
    enabled: true,
    samplingRate: 1,
    shadowProvider: 'shadow',
    sampleFn: () => 0,
  });
}

function comparisonFor(tenantId: string, taskType: string): ShadowComparisonResult {
  return {
    id: crypto.randomUUID(),
    comparisonGroupId: crypto.randomUUID(),
    taskType,
    primaryResponse: {
      content: 'primary',
      model: 'primary-model',
      provider: 'p',
      tokenUsage: { input: 1, output: 2, total: 3 },
      latencyMs: 10,
    },
    shadowResponse: {
      content: 'shadow',
      model: 'shadow-model',
      provider: 's',
      tokenUsage: { input: 4, output: 5, total: 9 },
      latencyMs: 20,
    },
    sampledAt: new Date(),
    tenantId,
  };
}

beforeAll(async () => {
  pool = await getSharedTestDb();
  store = new PgShadowComparisonStore(pool);
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
  for (const tenantId of createdTenantIds) {
    await pool.query('DELETE FROM shadow_comparisons WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
    await pool.query('DELETE FROM customers WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
    await pool.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('PgShadowComparisonStore (real Postgres)', () => {
  for (const flag of ['true', undefined] as const) {
    const label = flag ? 'RLS_RUNTIME_ROLE=true' : 'RLS_RUNTIME_ROLE unset (policy inert)';

    it(`${label}: a sampled LLM call persists its comparison and still returns the primary response`, async () => {
      if (flag) process.env.RLS_RUNTIME_ROLE = flag;
      else delete process.env.RLS_RUNTIME_ROLE;
      const { tenantId } = await seedTenant();

      const response = await sampledGateway().complete({
        taskType: 'draft_estimate',
        messages: [{ role: 'user', content: 'hello' }],
        tenantId,
      });

      expect(response.content).toBe('primary answer for jo@example.com');
      const page = await store.listForTenant(tenantId);
      expect(page.comparisons).toHaveLength(1);
      const [stored] = page.comparisons;
      expect(stored.tenantId).toBe(tenantId);
      expect(stored.taskType).toBe('draft_estimate');
      expect(stored.shadowResponse?.content).toBe('shadow answer');
      // Response text is scrubbed before it is stored.
      expect(stored.primaryResponse.content).not.toContain('jo@example.com');
      expect(stored.primaryResponse.tokenUsage).toEqual(response.tokenUsage);
    });

    it(`${label}: a tenant reads only its own comparisons`, async () => {
      if (flag) process.env.RLS_RUNTIME_ROLE = flag;
      else delete process.env.RLS_RUNTIME_ROLE;
      const a = await seedTenant();
      const b = await seedTenant();

      const mine = await store.save(comparisonFor(a.tenantId, 'classify'));
      await store.save(comparisonFor(b.tenantId, 'classify'));

      const pageA = await store.listForTenant(a.tenantId);
      expect(pageA.comparisons.map((c) => c.id)).toEqual([mine.id]);
      const filtered = await store.listForTenant(a.tenantId, { taskType: 'classify' });
      expect(filtered.comparisons.map((c) => c.id)).toEqual([mine.id]);
      expect((await store.listForTenant(b.tenantId)).comparisons.every((c) => c.tenantId === b.tenantId)).toBe(true);
    });
  }

  it('RLS_RUNTIME_ROLE=true: a sampled call inside an open tenant transaction leaves it usable', async () => {
    process.env.RLS_RUNTIME_ROLE = 'true';
    const { tenantId, userId } = await seedTenant();
    const customerId = crypto.randomUUID();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await applyTenantContext(client, tenantId, { transactional: true });
      await tenantContextStore.run({ client, tenantId }, async () => {
        // The request's own write, then an AI call that is sampled mid-request.
        await client.query(
          `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, created_by)
           VALUES ($1, $2, 'Shadow', 'Probe', 'Shadow Probe', $3)`,
          [customerId, tenantId, userId],
        );
        await sampledGateway().complete({
          taskType: 'draft_estimate',
          messages: [{ role: 'user', content: 'hello' }],
          tenantId,
        });
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const { rowCount } = await pool.query('SELECT 1 FROM customers WHERE id = $1', [customerId]);
    expect(rowCount).toBe(1);
    expect((await store.listForTenant(tenantId)).comparisons).toHaveLength(1);
  });
});
