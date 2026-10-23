/**
 * The gateway refuses (under test) or reports (in production) an LLM call
 * that starts while a tenant transaction holds a pooled connection.
 *
 * A route that awaits the LLM inside the /api request transaction pins that
 * connection, and under PgBouncer one server backend, for the whole call:
 * ~pool-size concurrent calls stall every tenant's /api, and a call longer
 * than the 60s idle-in-transaction timeout dies with its backend. Such routes
 * belong on LLM_LONG_CALL_ROUTES, with their writes in a short transaction
 * opened after the call (tenant-site about draft, resolve-entity A1). The
 * guard keeps the next one from slipping through: in tests the call throws a
 * typed error, so the route's own test fails; in production it logs an error
 * and counts it, and the call proceeds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import type { Pool, PoolClient } from 'pg';
import {
  LLMGateway,
  LlmCallInTransactionError,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from '../../../src/ai/gateway/gateway';
import {
  tenantContextStore,
  withTenantTransaction,
  type TenantContext,
} from '../../../src/middleware/tenant-context';
import { asyncRoute } from '../../../src/middleware/async-route';
import type { AuthenticatedRequest } from '../../../src/auth/clerk';
import { gatewayLlmCallInTransactionTotal } from '../../../src/monitoring/metrics';

const TENANT = '11111111-1111-4111-8111-111111111111';

function setup() {
  const provider: LLMProvider & { complete: ReturnType<typeof vi.fn> } = {
    name: 'stub',
    isAvailable: async () => true,
    complete: vi.fn(
      async (): Promise<LLMResponse> => ({
        content: 'About us copy',
        model: 'stub-model',
        provider: 'stub',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      }),
    ),
  };
  const logger = { info: vi.fn(), error: vi.fn() };
  const gateway = new LLMGateway({ defaultProvider: 'stub' }, new Map([['stub', provider]]), logger);
  return { provider, logger, gateway };
}

const request: LLMRequest = {
  taskType: 'tenant_site_about',
  tenantId: TENANT,
  messages: [{ role: 'user', content: 'Write the About us text.' }],
};

/** What the request-transaction middleware (or a tenant transaction runner) publishes. */
function heldTransaction(): TenantContext {
  return { client: { query: vi.fn() } as unknown as PoolClient, tenantId: TENANT };
}

async function guardCount(taskType: string): Promise<number> {
  const metric = await gatewayLlmCallInTransactionTotal.get();
  return metric.values.find((v) => v.labels.task_type === taskType)?.value ?? 0;
}

const guardLogs = (logger: { error: ReturnType<typeof vi.fn> }) =>
  logger.error.mock.calls.filter(([message]) => String(message).includes('transaction'));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('LLM gateway — no LLM call while a tenant transaction holds a connection', () => {
  it('under test, a call started inside a request transaction throws a typed error before reaching the provider', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const { gateway, provider } = setup();

    const call = tenantContextStore.run(heldTransaction(), () => gateway.complete(request));

    await expect(call).rejects.toBeInstanceOf(LlmCallInTransactionError);
    await expect(
      tenantContextStore.run(heldTransaction(), () => gateway.complete(request)),
    ).rejects.toMatchObject({ code: 'LLM_CALL_IN_TRANSACTION', taskType: 'tenant_site_about' });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('in production it logs an error, counts it, and returns the completion', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { gateway, provider, logger } = setup();
    const before = await guardCount('tenant_site_about');

    const response = await tenantContextStore.run(heldTransaction(), () => gateway.complete(request));

    expect(response.content).toBe('About us copy');
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(await guardCount('tenant_site_about')).toBe(before + 1);
    const logs = guardLogs(logger);
    expect(logs).toHaveLength(1);
    expect(logs[0][1]).toMatchObject({ taskType: 'tenant_site_about', tenantId: TENANT });
    expect(String((logs[0][1] as { stack?: unknown }).stack)).toContain('gateway-transaction-guard.test.ts');
  });

  it('with no tenant transaction (an LLM_LONG_CALL_ROUTE, a worker) the call is untouched', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const { gateway, provider, logger } = setup();
    const before = await guardCount('tenant_site_about');

    await expect(gateway.complete(request)).resolves.toMatchObject({ content: 'About us copy' });

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(guardLogs(logger)).toHaveLength(0);
    expect(await guardCount('tenant_site_about')).toBe(before);
  });

  it('a transaction that has started settling holds nothing for the caller, so a call made after it is untouched', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const { gateway, provider } = setup();
    const settling = heldTransaction();
    settling.closed = true;

    await expect(tenantContextStore.run(settling, () => gateway.complete(request))).resolves.toMatchObject({
      content: 'About us copy',
    });
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('an explicit short transaction is flagged the same way if it ever spans an LLM call', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const { gateway, provider } = setup();
    // PgTenantTransactionRunner publishes the same kind of entry for its unit of work.
    const unitOfWork = heldTransaction();

    await expect(
      tenantContextStore.run(unitOfWork, async () => {
        await Promise.resolve();
        return gateway.complete(request);
      }),
    ).rejects.toBeInstanceOf(LlmCallInTransactionError);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  /**
   * The guard with the REAL request-transaction middleware in front: a route
   * that awaits the gateway inside the request transaction fails its test
   * (500 LLM_CALL_IN_TRANSACTION, rolled back), and the same handler on an
   * LLM_LONG_CALL_ROUTES path runs with no request transaction and succeeds.
   */
  it('through the real middleware: an in-request call 500s with the typed error; a bypassed route is untouched', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const { gateway, provider } = setup();
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql.trim());
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const app = express();
    app.use((req, _res, next) => {
      (req as AuthenticatedRequest).auth = { userId: 'u1', sessionId: 's1', tenantId: TENANT, role: 'owner' };
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    const draft = asyncRoute(async (_req, res) => {
      const response = await gateway.complete(request);
      res.status(201).json({ content: response.content });
    });
    // Same handler, two paths: one the middleware wraps in the request
    // transaction, one on LLM_LONG_CALL_ROUTES.
    app.post('/api/tenant-site/about/preview-draft', draft);
    app.post('/api/tenant-site/about/draft', draft);

    const inRequest = await supertest(app).post('/api/tenant-site/about/preview-draft');
    expect(inRequest.status).toBe(500);
    expect(inRequest.body.error).toBe('LLM_CALL_IN_TRANSACTION');
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(provider.complete).not.toHaveBeenCalled();

    statements.length = 0;
    const bypassed = await supertest(app).post('/api/tenant-site/about/draft');
    expect(bypassed.status).toBe(201);
    expect(bypassed.body.content).toBe('About us copy');
    expect(statements).toEqual([]);
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });
});
