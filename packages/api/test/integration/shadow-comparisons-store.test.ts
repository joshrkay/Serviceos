/**
 * Postgres integration — the durable shadow-comparison store (P2-030) against
 * the REAL schema.
 *
 * `PgShadowComparisonStore` reached main (#1615) without its table: migration
 * `101_create_shadow_comparisons` stayed on its feature branch (101 went to
 * `101_google_reviews`), so with `SHADOW_LLM_ENABLED=true` and a pool
 * (app.ts) every SAMPLED LLM call's `save()` hit 42P01 and
 * `ShadowComparisonGateway.complete` rejected — after the primary call had
 * already succeeded. Inside a request, `save()` ran on the ambient request
 * client (PgBaseRepository reuse), so the failed INSERT also aborted the
 * whole request transaction. And a platform call filed under
 * SYSTEM_TENANT_ID ('system') failed `withTenant`'s UUID check outright. The
 * store's unit tests mock the Pool, so none of that was visible; this file
 * executes every statement for real.
 *
 * It pins: a sampled call through the gateway persists and returns the
 * primary response; a 'system' call persists under the placeholder tenant and
 * reads back the same way; a save that Postgres refuses, made from a request
 * served by the real `withTenantTransaction` middleware, changes neither the
 * response nor the request's own committed write; and the store's read is
 * tenant-bounded with the RLS runtime role on and off (`listForTenant`
 * filters `tenant_id = $1`, and the table is ENABLE + FORCE RLS).
 *
 * The gateway saves detached from the call (best-effort, its own short
 * transaction), so each test waits on the store's own save promise before
 * reading.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { PgShadowComparisonStore } from '../../src/ai/evaluation/pg-shadow-comparison';
import {
  ShadowComparisonGateway,
  type ShadowComparisonResult,
} from '../../src/ai/evaluation/shadow-comparison';
import { StubProvider } from '../../src/ai/gateway/providers';
import { SYSTEM_TENANT_ID } from '../../src/ai/gateway/gateway';
import { applyTenantContext } from '../../src/db/rls-runtime-role';
import { withTenantClient } from '../../src/db/tenant-transaction';
import { tenantContextStore, withTenantTransaction } from '../../src/middleware/tenant-context';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const PLACEHOLDER_TENANT = '00000000-0000-0000-0000-000000000000';

let pool: Pool;
let store: ObservedStore;
const createdTenantIds: string[] = [];
const placeholderTaskTypes: string[] = [];

/** The real store, keeping each save's promise so a test can wait on the detached write. */
class ObservedStore extends PgShadowComparisonStore {
  saves: Array<Promise<ShadowComparisonResult>> = [];
  override save(result: ShadowComparisonResult): Promise<ShadowComparisonResult> {
    const pending = super.save(result);
    this.saves.push(pending);
    return pending;
  }
  async settled(): Promise<PromiseSettledResult<ShadowComparisonResult>[]> {
    return Promise.allSettled(this.saves.splice(0));
  }
}

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

function setFlag(flag: 'true' | undefined): void {
  if (flag) process.env.RLS_RUNTIME_ROLE = flag;
  else delete process.env.RLS_RUNTIME_ROLE;
}

beforeAll(async () => {
  pool = await getSharedTestDb();
  store = new ObservedStore(pool);
});

afterEach(async () => {
  await store.settled();
  setFlag(ORIGINAL_FLAG as 'true' | undefined);
});

afterAll(async () => {
  setFlag(ORIGINAL_FLAG as 'true' | undefined);
  for (const taskType of placeholderTaskTypes) {
    await pool
      .query('DELETE FROM shadow_comparisons WHERE tenant_id = $1 AND task_type = $2', [PLACEHOLDER_TENANT, taskType])
      .catch(() => undefined);
  }
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
      setFlag(flag);
      const { tenantId } = await seedTenant();

      const response = await sampledGateway().complete({
        taskType: 'draft_estimate',
        messages: [{ role: 'user', content: 'hello' }],
        tenantId,
      });

      expect(response.content).toBe('primary answer for jo@example.com');
      expect((await store.settled()).map((s) => s.status)).toEqual(['fulfilled']);
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

    it(`${label}: a 'system' call persists under the placeholder tenant and reads back as 'system'`, async () => {
      setFlag(flag);
      const taskType = `system-probe-${crypto.randomUUID()}`;
      placeholderTaskTypes.push(taskType);

      const response = await sampledGateway().complete({
        taskType,
        messages: [{ role: 'user', content: 'ping' }],
        tenantId: SYSTEM_TENANT_ID,
      });

      expect(response.content).toBe('primary answer for jo@example.com');
      const [outcome] = await store.settled();
      expect(outcome.status).toBe('fulfilled');
      const { rows } = await pool.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM shadow_comparisons WHERE task_type = $1',
        [taskType],
      );
      expect(rows).toEqual([{ tenant_id: PLACEHOLDER_TENANT }]);
      const viaSystem = await store.listForTenant(SYSTEM_TENANT_ID, { taskType });
      expect(viaSystem.comparisons).toHaveLength(1);
      expect(viaSystem.comparisons[0].tenantId).toBe(PLACEHOLDER_TENANT);
    });

    it(`${label}: a tenant reads only its own comparisons`, async () => {
      setFlag(flag);
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
    setFlag('true');
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
    expect((await store.settled()).map((s) => s.status)).toEqual(['fulfilled']);
    expect((await store.listForTenant(tenantId)).comparisons).toHaveLength(1);
  });

  it('RLS_RUNTIME_ROLE=true: a save Postgres refuses, inside a real request transaction, changes neither the response nor the request write', async () => {
    setFlag('true');
    const tenant = await seedTenant();
    const customerId = crypto.randomUUID();
    // No ai_runs row has this id: the INSERT fails its foreign key (23503)
    // in Postgres — a real store failure, not a mock.
    const danglingAiRunId = crypto.randomUUID();

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: tenant.userId,
        sessionId: 'sess-shadow',
        tenantId: tenant.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    app.post('/api/probe', async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        // The request's own write, on the request transaction's client.
        await withTenantClient(pool, tenantId, (db) =>
          db.query(
            `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, created_by)
             VALUES ($1, $2, 'Shadow', 'Request', 'Shadow Request', $3)`,
            [customerId, tenantId, tenant.userId],
          ),
        );
        const response = await sampledGateway().complete({
          taskType: 'draft_estimate',
          messages: [{ role: 'user', content: 'hello' }],
          tenantId,
          metadata: { aiRunId: danglingAiRunId },
        });
        // A later statement on the same request transaction must still run.
        const { rows } = await withTenantClient(pool, tenantId, (db) =>
          db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM customers WHERE id = $1', [customerId]),
        );
        res.json({ content: response.content, customersSeen: rows[0].n });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    const res = await request(app).post('/api/probe').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ content: 'primary answer for jo@example.com', customersSeen: 1 });
    const [outcome] = await store.settled();
    expect(outcome.status).toBe('rejected');
    expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: '23503' });
    // The request committed its own write; the refused comparison left nothing.
    const { rowCount } = await pool.query('SELECT 1 FROM customers WHERE id = $1', [customerId]);
    expect(rowCount).toBe(1);
    const { rowCount: shadowRows } = await pool.query('SELECT 1 FROM shadow_comparisons WHERE ai_run_id = $1', [
      danglingAiRunId,
    ]);
    expect(shadowRows).toBe(0);
  });
});
