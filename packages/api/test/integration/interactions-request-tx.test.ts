/**
 * Postgres integration — GET /api/interactions and /api/interactions/:id read
 * call transcripts on the request transaction's client, under the RLS runtime
 * role.
 *
 * Both handlers checked out a SECOND pooled connection and opened their own
 * transaction with only the tenant GUC set
 * (`set_config('app.current_tenant_id', $1, true)`), never the role. So the
 * reads ran as the privileged connection principal, with the RLS policies on
 * voice_sessions, customers and service_locations inert, while the request's
 * own rls_app_runtime transaction sat idle on the first connection.
 *
 * The suite mounts the real `withTenantTransaction` middleware, forces
 * RLS_RUNTIME_ROLE on, and asks Postgres (statement-role-probe) which role and
 * tenant each voice_sessions read ran under.
 */
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, type TestTenant } from './shared';
import { probeStatementRoles, type StatementRoleProbe } from './statement-role-probe';
import { createInteractionsRouter } from '../../src/routes/interactions';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;

let pool: Pool;
let probe: StatementRoleProbe;
let a: TestTenant;
let b: TestTenant;
let aSessions: string[];
let bSession: string;

function buildApp(dbPool: Pool, acting: TestTenant, opts: { requestTransaction: boolean }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: acting.userId,
      sessionId: 'sess-test',
      tenantId: acting.tenantId,
      role: 'owner',
    };
    next();
  });
  if (opts.requestTransaction) app.use('/api', withTenantTransaction(dbPool));
  app.use(
    '/api/interactions',
    createInteractionsRouter({ pool: dbPool, dispatchRepo: new InMemoryDispatchRepository() }),
  );
  return app;
}

async function seedSession(tenant: TestTenant, startedAt: string): Promise<string> {
  const customerId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, created_by)
     VALUES ($1, $2, 'Call', 'Er', 'Call Er', $3)`,
    [customerId, tenant.tenantId, tenant.userId],
  );
  await pool.query(
    `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code, is_primary)
     VALUES ($1, $2, $3, '1 Main St', 'Austin', 'TX', '78701', true)`,
    [crypto.randomUUID(), tenant.tenantId, customerId],
  );
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO voice_sessions (id, tenant_id, customer_id, channel, state, started_at, transcript)
     VALUES ($1, $2, $3, 'voice_inbound', 'completed', $4, $5::jsonb)`,
    [id, tenant.tenantId, customerId, startedAt, JSON.stringify(['caller: my sink leaks'])],
  );
  return id;
}

function expectRuntimeRoleFor(tenant: TestTenant, statements: number): void {
  expect(probe.seen).toHaveLength(statements);
  for (const statement of probe.seen) {
    expect(statement).toMatchObject({ role: 'rls_app_runtime', tenantGuc: tenant.tenantId });
  }
}

beforeAll(async () => {
  pool = await getSharedTestDb();
});

beforeEach(async () => {
  process.env.RLS_RUNTIME_ROLE = 'true';
  a = await createTestTenant(pool);
  b = await createTestTenant(pool);
  aSessions = [
    await seedSession(a, '2026-03-01T10:00:00Z'),
    await seedSession(a, '2026-03-02T10:00:00Z'),
  ];
  bSession = await seedSession(b, '2026-03-03T10:00:00Z');
  probe = probeStatementRoles(pool, /FROM voice_sessions/);
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  await closeSharedTestDb();
});

describe('GET /api/interactions (real Postgres, request transaction)', () => {
  it("lists only the acting tenant's calls, read as rls_app_runtime", async () => {
    const res = await request(buildApp(probe.pool, a, { requestTransaction: true })).get('/api/interactions');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data.map((d: { id: string }) => d.id).sort()).toEqual([...aSessions].sort());
    expect(res.body.data[0].customer.address).toBe('1 Main St');
    expectRuntimeRoleFor(a, 2); // the count and the page
  });

  it('takes no second pooled connection: it answers on a one-connection pool', async () => {
    const single = new Pool({ connectionString: process.env.TEST_DB_URL, max: 1, connectionTimeoutMillis: 3000 });
    try {
      const res = await request(buildApp(single, a, { requestTransaction: true })).get('/api/interactions');
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
    } finally {
      await single.end();
    }
  });

  it('without a request transaction, still reads under its own rls_app_runtime transaction', async () => {
    const res = await request(buildApp(probe.pool, a, { requestTransaction: false })).get('/api/interactions');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expectRuntimeRoleFor(a, 2);
  });
});

describe('GET /api/interactions/:id (real Postgres, request transaction)', () => {
  it("returns the acting tenant's call, read as rls_app_runtime", async () => {
    const res = await request(buildApp(probe.pool, a, { requestTransaction: true })).get(
      `/api/interactions/${aSessions[0]}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(aSessions[0]);
    expect(res.body.transcript).toEqual(['caller: my sink leaks']);
    expectRuntimeRoleFor(a, 1);
  });

  it("answers 404 for another tenant's call", async () => {
    const res = await request(buildApp(probe.pool, a, { requestTransaction: true })).get(
      `/api/interactions/${bSession}`,
    );

    expect(res.status).toBe(404);
    expectRuntimeRoleFor(a, 1);
  });

  it('takes no second pooled connection: it answers on a one-connection pool', async () => {
    const single = new Pool({ connectionString: process.env.TEST_DB_URL, max: 1, connectionTimeoutMillis: 3000 });
    try {
      const res = await request(buildApp(single, a, { requestTransaction: true })).get(
        `/api/interactions/${aSessions[1]}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(aSessions[1]);
    } finally {
      await single.end();
    }
  });
});
