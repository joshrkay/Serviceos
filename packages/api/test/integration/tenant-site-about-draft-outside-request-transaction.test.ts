/**
 * POST /api/tenant-site/about/draft must not hold a pooled connection across
 * its LLM call, and its post-LLM writes must still commit as one unit.
 *
 * The draft awaits the tenant_site_about gateway call (up to the 60s gateway
 * deadline) before it writes. Inside the /api request transaction that pinned
 * one pooled connection - and under PgBouncer one server backend - for the
 * whole call: ~pool-size drafts in flight stalled every tenant's /api, and a
 * call past `idle_in_transaction_session_timeout` died with the backend. The
 * route is now an LLM_LONG_CALL_ROUTE (no request transaction): the reads
 * before the call each run in their own short transaction, and supersede-old,
 * create-new and the audit row commit together in ONE PgTenantTransactionRunner
 * transaction opened after the call returns, under a per-tenant advisory lock
 * so concurrent drafts keep the one-pending-draft rule.
 *
 * Real Postgres, RLS_RUNTIME_ROLE=true, the REAL request-transaction
 * middleware, the REAL tenant-site router and Pg repositories, and the REAL
 * TenantSiteAboutTask + LLMGateway over a stub provider that blocks until
 * released. The app pool has max=3 and five drafts are in flight at once, so
 * "an unrelated request completes while they wait" is a hard proof: holding
 * the request transaction, three drafts would pin the whole pool and the
 * other two would never reach the LLM.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { Pool, PoolClient } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { createPool } from '../../src/db/pool';
import { currentTenantContext, withTenantTransaction } from '../../src/middleware/tenant-context';
import { PgTenantTransactionRunner } from '../../src/db/tenant-transaction';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgTenantSiteRepository } from '../../src/tenant-site/tenant-site';
import { InMemoryVerticalPackRegistry } from '../../src/shared/vertical-pack-registry';
import { createProposal, type Proposal } from '../../src/proposals/proposal';
import { createTenantSiteRouter } from '../../src/routes/tenant-site';
import { TenantSiteAboutTask } from '../../src/ai/tasks/tenant-site-about-task';
import { LLMGateway, type LLMProvider, type LLMResponse } from '../../src/ai/gateway/gateway';

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Rejects after `ms` so a regression fails with a reason instead of hanging. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface LoggedStatement {
  sql: string;
  params: unknown[];
}

/**
 * The app pool, with every statement on every checked-out client logged in
 * order. `failWhen` turns the next matching statement into a real Postgres
 * error (division_by_zero) - a database failure inside the transaction, not a
 * thrown JS stub.
 */
function loggingPool(realPool: Pool, log: LoggedStatement[], injection: { failWhen: RegExp | null }): Pool {
  const instrumented = new WeakSet<PoolClient>();
  const connect = async (): Promise<PoolClient> => {
    const client = await realPool.connect();
    if (!instrumented.has(client)) {
      instrumented.add(client);
      const realQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = (...args: unknown[]) => {
        const sql = (typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text)).trim();
        log.push({ sql, params: Array.isArray(args[1]) ? (args[1] as unknown[]) : [] });
        if (injection.failWhen?.test(sql)) {
          injection.failWhen = null;
          return realQuery('SELECT 1/0 AS injected_failure');
        }
        return realQuery(...args);
      };
    }
    return client;
  };
  return { connect } as unknown as Pool;
}

const POOL_MAX = 3;
const DRAFTS = POOL_MAX + 2;

function appPool(baseUrl: string): Pool {
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    DB_SSL: process.env.DB_SSL,
    DB_MAX_CONNECTIONS: process.env.DB_MAX_CONNECTIONS,
  };
  const url = new URL(baseUrl);
  url.searchParams.set('application_name', 'rivet_tenant_site_about_draft');
  process.env.DATABASE_URL = url.toString();
  process.env.DB_SSL = 'false';
  process.env.DB_MAX_CONNECTIONS = String(POOL_MAX);
  try {
    return createPool();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

type Tenant = { tenantId: string; userId: string };

describe('tenant-site about draft — no connection held across the LLM call, post-LLM writes as one unit', () => {
  let harnessPool: Pool;
  let realAppPool: Pool;
  let server: Server;
  let baseUrl: string;
  let tenantA: Tenant;
  let tenantB: Tenant;
  let tenantC: Tenant;
  const log: LoggedStatement[] = [];
  const injection: { failWhen: RegExp | null } = { failWhen: null };

  // Per-test LLM control.
  let release: Deferred;
  let allEntered: Deferred;
  let expectedCalls = 0;
  let drafted = 0;
  const probes: Array<{ store: unknown; tenantId: string | undefined }> = [];

  beforeAll(async () => {
    expect(process.env.RLS_RUNTIME_ROLE, 'this proof needs the RLS runtime role on').toBe('true');
    harnessPool = await getSharedTestDb();
    const dbUrl = process.env.TEST_DB_URL as string;
    expect(dbUrl, 'TEST_DB_URL must be set by the integration globalSetup').toBeTruthy();
    tenantA = await createTestTenant(harnessPool);
    tenantB = await createTestTenant(harnessPool);
    tenantC = await createTestTenant(harnessPool);
    const seedSettings = new PgSettingsRepository(harnessPool);
    await seedSettings.upsertIdentityFields(tenantA.tenantId, { businessName: 'Acme Plumbing' });
    await seedSettings.upsertIdentityFields(tenantB.tenantId, { businessName: 'Bravo Heating' });
    await seedSettings.upsertIdentityFields(tenantC.tenantId, { businessName: 'Charlie Electric' });

    realAppPool = appPool(dbUrl);
    const pool = loggingPool(realAppPool, log, injection);
    const settingsRepo = new PgSettingsRepository(pool);

    // The model: records what it can see, then blocks until released.
    const provider: LLMProvider = {
      name: 'stub',
      isAvailable: async () => true,
      complete: async (request): Promise<LLMResponse> => {
        probes.push({ store: currentTenantContext(), tenantId: request.tenantId });
        if (probes.length === expectedCalls) allEntered.resolve();
        await release.promise;
        drafted += 1;
        return {
          content: `We fix pipes across town, draft ${drafted}. Call us for a quote.`,
          model: 'stub-model',
          provider: 'stub',
          tokenUsage: { input: 10, output: 20, total: 30 },
          latencyMs: 1,
        };
      },
    };
    const gateway = new LLMGateway({ defaultProvider: 'stub' }, new Map([['stub', provider]]));

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const tenantId = req.headers['x-test-tenant'];
      if (typeof tenantId === 'string') {
        (req as unknown as { auth: Record<string, string> }).auth = {
          userId: String(req.headers['x-test-user']),
          sessionId: 'sess-about-draft',
          tenantId,
          role: 'owner',
        };
      }
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    app.use(
      '/api/tenant-site',
      createTenantSiteRouter({
        baseDomain: 'sites.example-pages.test',
        siteRepo: new PgTenantSiteRepository(pool),
        settingsRepo,
        viewDeps: { settingsRepo, packRegistry: new InMemoryVerticalPackRegistry(), webOrigin: 'https://app.example.test' },
        auditRepo: new PgAuditRepository(pool),
        aboutTask: new TenantSiteAboutTask(gateway),
        proposalRepo: new PgProposalRepository(pool),
        transactionRunner: new PgTenantTransactionRunner(pool),
      }),
    );

    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    release?.resolve();
    await new Promise<void>((resolve) => {
      server?.closeAllConnections?.();
      if (server) server.close(() => resolve());
      else resolve();
    });
    await realAppPool?.end().catch(() => undefined);
    const tenants = [tenantA?.tenantId, tenantB?.tenantId, tenantC?.tenantId].filter(Boolean);
    await harnessPool.query('DELETE FROM audit_events WHERE tenant_id = ANY($1)', [tenants]);
    await harnessPool.query('DELETE FROM proposals WHERE tenant_id = ANY($1)', [tenants]);
    await closeSharedTestDb();
  });

  function armLlm(calls: number, hold: boolean): void {
    probes.length = 0;
    expectedCalls = calls;
    allEntered = deferred();
    release = deferred();
    if (!hold) release.resolve();
  }

  const call = (method: 'GET' | 'POST', path: string, tenant: Tenant) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-test-tenant': tenant.tenantId,
        'x-test-user': tenant.userId,
      },
    });

  async function seedPendingDraft(tenant: Tenant): Promise<Proposal> {
    return new PgProposalRepository(harnessPool).create(
      createProposal({
        tenantId: tenant.tenantId,
        proposalType: 'update_tenant_site_about',
        payload: { aboutText: 'An older draft nobody approved.' },
        summary: 'Add an "About us" section to your website',
        createdBy: tenant.userId,
        targetEntityType: 'tenant_site',
        targetEntityId: tenant.tenantId,
      }),
    );
  }

  async function aboutProposals(tenantId: string) {
    const { rows } = await harnessPool.query<{ id: string; status: string; rejection_reason: string | null }>(
      `SELECT id, status, rejection_reason FROM proposals
        WHERE tenant_id = $1 AND proposal_type = 'update_tenant_site_about'
        ORDER BY created_at`,
      [tenantId],
    );
    return rows;
  }

  async function auditCount(tenantId: string, eventType: string): Promise<number> {
    const { rows } = await harnessPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND event_type = $2',
      [tenantId, eventType],
    );
    return rows[0].n;
  }

  it(`with ${DRAFTS} drafts waiting on the LLM and a pool of ${POOL_MAX}, another tenant's request completes; after release exactly one draft is pending and every other is superseded`, async () => {
    const stale = await seedPendingDraft(tenantA);
    armLlm(DRAFTS, true);

    let settled = 0;
    const drafts = Array.from({ length: DRAFTS }, () =>
      call('POST', '/api/tenant-site/about/draft', tenantA).finally(() => {
        settled += 1;
      }),
    );

    // Every draft reaches the LLM: none of them is holding a connection.
    await within(allEntered.promise, 10_000, `all ${DRAFTS} drafts reaching the LLM call`);
    expect(probes).toHaveLength(DRAFTS);
    expect(probes.every((p) => p.store === undefined && p.tenantId === tenantA.tenantId)).toBe(true);
    expect(realAppPool.totalCount - realAppPool.idleCount).toBe(0);

    // An unrelated tenant's ordinary request runs its request transaction now.
    const startedAt = Date.now();
    const other = await within(call('GET', '/api/tenant-site/about', tenantB), 5_000, "tenant B's request");
    expect(other.status).toBe(200);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(settled).toBe(0);
    const bTenantSet = log.findIndex(
      (s) => s.sql.includes("set_config('app.current_tenant_id'") && s.params[0] === tenantB.tenantId,
    );
    expect(bTenantSet).toBeGreaterThan(0);
    expect(log[bTenantSet - 1].sql).toBe('BEGIN');

    release.resolve();
    const responses = await Promise.all(drafts);
    expect(responses.map((r) => r.status)).toEqual(Array(DRAFTS).fill(201));
    const ids = await Promise.all(
      responses.map(async (r) => ((await r.json()) as { data: { proposalId: string } }).data.proposalId),
    );
    expect(new Set(ids).size).toBe(DRAFTS);

    // Each draft made exactly one proposal; one is left pending and the
    // seeded stale draft plus every other new one were superseded.
    const rows = await aboutProposals(tenantA.tenantId);
    expect(rows.map((r) => r.id).sort()).toEqual([stale.id, ...ids].sort());
    const pending = rows.filter((r) => r.status === 'draft' || r.status === 'ready_for_review');
    expect(pending).toHaveLength(1);
    expect(ids).toContain(pending[0].id);
    const superseded = rows.filter((r) => r.id !== pending[0].id);
    expect(superseded).toHaveLength(DRAFTS);
    expect(superseded.every((r) => r.status === 'rejected' && r.rejection_reason === 'superseded')).toBe(true);
    expect(await auditCount(tenantA.tenantId, 'tenant_site.about_drafted')).toBe(DRAFTS);
    expect(await auditCount(tenantA.tenantId, 'proposal.rejected')).toBe(DRAFTS);
  });

  it('a database failure after the LLM call (the proposal insert) rolls the supersede back: the old draft stays pending, nothing new, no audit; a retry then lands', async () => {
    const stale = await seedPendingDraft(tenantC);
    armLlm(1, false);
    log.length = 0;
    injection.failWhen = /^INSERT INTO proposals/;

    const failed = await call('POST', '/api/tenant-site/about/draft', tenantC);
    expect(failed.status).toBe(500);
    expect(injection.failWhen).toBeNull(); // the injected failure fired

    // The supersede ran inside the transaction, which then rolled back.
    const sqls = log.map((s) => s.sql);
    const supersede = sqls.findIndex((s) => s.startsWith('UPDATE proposals SET status'));
    expect(supersede).toBeGreaterThan(0);
    expect(sqls.slice(supersede).find((s) => s === 'COMMIT' || s === 'ROLLBACK')).toBe('ROLLBACK');

    // No superseded-without-replacement state survived.
    expect(await aboutProposals(tenantC.tenantId)).toEqual([
      { id: stale.id, status: 'draft', rejection_reason: null },
    ]);
    expect(await auditCount(tenantC.tenantId, 'proposal.rejected')).toBe(0);
    expect(await auditCount(tenantC.tenantId, 'tenant_site.about_drafted')).toBe(0);

    // The retry lands, and its writes after the LLM call are ONE transaction:
    // the lock, then supersede + its audit + create + audit, one COMMIT.
    log.length = 0;
    const retried = await call('POST', '/api/tenant-site/about/draft', tenantC);
    expect(retried.status).toBe(201);
    const newId = ((await retried.json()) as { data: { proposalId: string } }).data.proposalId;
    expect(await aboutProposals(tenantC.tenantId)).toEqual([
      { id: stale.id, status: 'rejected', rejection_reason: 'superseded' },
      { id: newId, status: 'draft', rejection_reason: null },
    ]);
    const after = log.map((s) => s.sql);
    const lock = after.findIndex((s) => s.startsWith('SELECT pg_advisory_xact_lock'));
    const begin = after.lastIndexOf('BEGIN', lock);
    const commit = after.indexOf('COMMIT', lock);
    const tx = after.slice(begin, commit + 1);
    expect(log[begin + 1].params[0]).toBe(tenantC.tenantId);
    expect(tx).toContain('SET LOCAL ROLE rls_app_runtime');
    const statusWrite = tx.findIndex((s) => s.startsWith('UPDATE proposals SET status'));
    const insert = tx.findIndex((s) => s.startsWith('INSERT INTO proposals'));
    const audits = tx.flatMap((s, i) => (s.startsWith('INSERT INTO audit_events') ? [i] : []));
    expect(statusWrite).toBeGreaterThan(tx.findIndex((s) => s.startsWith('SELECT pg_advisory_xact_lock')));
    expect(insert).toBeGreaterThan(statusWrite);
    expect(audits).toHaveLength(2);
    expect(audits[1]).toBeGreaterThan(insert);
    expect(tx.filter((s) => s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK')).toEqual(['BEGIN', 'COMMIT']);
    expect(await auditCount(tenantC.tenantId, 'proposal.rejected')).toBe(1);
    expect(await auditCount(tenantC.tenantId, 'tenant_site.about_drafted')).toBe(1);
  });
});
