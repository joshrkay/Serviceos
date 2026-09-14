/**
 * #1133 — the request transaction must be durable BEFORE the client can see
 * the response.
 *
 * `withTenantTransaction` used to COMMIT from `res.once('finish')`. Node emits
 * `finish` after the response has been handed to the socket, so a client could
 * already hold the 201 while the COMMIT was still in flight and fire the
 * dependent request into a transaction that cannot see the row — observed in
 * the e2e run log as `POST /api/locations 201` followed 9 ms later by
 * `POST /api/jobs → 404 Location not found`.
 *
 * Real Postgres, the REAL middleware mounted the way app.ts mounts it
 * (`app.use('/api', …)`, behind an auth shim and an outer middleware that
 * listens on `finish` like request-logging does), and real HTTP over a socket.
 *
 * Deterministic, not timing luck. A seam on the pool's clients inspects every
 * COMMIT the moment it is issued: if the response that transaction belongs to
 * has ALREADY been flushed to the socket (`finish` has fired), the COMMIT is
 * held until the client has received that response and made its dependent
 * reads. That hold is exactly the window the defect lives in, widened to "as
 * long as the client needs" — so while the defect exists every iteration
 * observes it, and once the COMMIT happens before the response is flushed the
 * hold can never engage. No sleeps decide the outcome.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, RLS_APP_ROLE } from './shared';
import { createPool } from '../../src/db/pool';
import {
  currentTenantContext,
  runAfterCommit,
  withTenantTransaction,
} from '../../src/middleware/tenant-context';

const ITERATIONS = 10;
const DEFERRED_TABLE = 'test_1133_deferred_unique';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Per-request probe the write handler registers against the request-scoped
 * client, so the COMMIT seam knows which response that COMMIT belongs to.
 */
interface WriteProbe {
  res: express.Response;
  /** Opened by the test once the client has made its dependent reads. */
  clientDone: Deferred;
  /** Resolved once the real COMMIT has returned (either way). */
  commitSettled: Deferred;
  /** Whether the seam had to hold this COMMIT (the response was already out). */
  heldBecauseResponseWasFlushed?: boolean;
}

/**
 * The app pool (built with the repo's own `createPool`, so connection guards
 * and settings match production) wrapped so every checked-out client's COMMIT
 * passes through the seam described in the header.
 */
function instrumentedPool(realPool: Pool, probes: Map<PoolClient, WriteProbe>): Pool {
  const instrumented = new WeakSet<PoolClient>();
  const connect = async (): Promise<PoolClient> => {
    const client = await realPool.connect();
    if (!instrumented.has(client)) {
      instrumented.add(client);
      const realQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (
        ...args: unknown[]
      ) => {
        if (args[0] !== 'COMMIT') return realQuery(...args);
        const probe = probes.get(client);
        if (!probe) return realQuery(...args);
        probes.delete(client);
        probe.heldBecauseResponseWasFlushed = probe.res.locals.responseFlushed === true;
        if (probe.heldBecauseResponseWasFlushed) await probe.clientDone.promise;
        try {
          return await realQuery(...args);
        } finally {
          probe.commitSettled.resolve();
        }
      };
    }
    return client;
  };
  return { connect } as unknown as Pool;
}

/** Probes queued by the test for the next `POST /api/rows`. */
const pendingProbes: WriteProbe[] = [];
const afterCommitRuns: string[] = [];

interface Harness {
  url: string;
  close: () => Promise<void>;
}

async function startHarness(pool: Pool, probes: Map<PoolClient, WriteProbe>): Promise<Harness> {
  const app = express();
  // Outer middleware mounted BEFORE the request transaction, like app.ts's
  // request logging: records when the response has been flushed to the socket.
  app.use((_req, res, next) => {
    res.on('finish', () => {
      res.locals.responseFlushed = true;
    });
    next();
  });
  app.use((req, _res, next) => {
    const tenantId = req.headers['x-test-tenant'];
    if (typeof tenantId === 'string') {
      (req as unknown as { auth: { tenantId: string } }).auth = { tenantId };
    }
    next();
  });
  app.use('/api', withTenantTransaction(pool));

  // Create: one INSERT on the request client, then 201 with the new id.
  app.post('/api/rows', (_req, res) => {
    void (async () => {
      const ctx = currentTenantContext()!;
      const { rows } = await ctx.client.query<{ id: string }>(
        `INSERT INTO dropped_call_recoveries
           (tenant_id, voice_session_id, caller_e164, scheduled_for)
         VALUES (current_setting('app.current_tenant_id')::uuid, $1, $2, NOW())
         RETURNING id`,
        [uuidv4(), '+15125550133'],
      );
      const probe = pendingProbes.shift();
      if (probe) {
        probe.res = res;
        probes.set(ctx.client, probe);
      }
      res.status(201).json({ id: rows[0].id });
    })();
  });

  // Dependent read: what `POST /api/jobs` does with the location id — look the
  // row up inside its own request transaction (RLS-scoped) or 404.
  app.get('/api/rows/:id', (req, res) => {
    void (async () => {
      const ctx = currentTenantContext()!;
      const { rows } = await ctx.client.query('SELECT id FROM dropped_call_recoveries WHERE id = $1', [
        req.params.id,
      ]);
      if (rows.length === 0) {
        res.status(404).json({ error: 'NOT_FOUND', message: `Row not found: ${req.params.id}` });
        return;
      }
      res.status(200).json({ id: rows[0].id });
    })();
  });

  // A write that responds 4xx must still roll back.
  app.post('/api/rows-conflict', (_req, res) => {
    void (async () => {
      const ctx = currentTenantContext()!;
      await ctx.client.query(
        `INSERT INTO dropped_call_recoveries
           (tenant_id, voice_session_id, caller_e164, scheduled_for)
         VALUES (current_setting('app.current_tenant_id')::uuid, $1, $2, NOW())`,
        [uuidv4(), '+15125550144'],
      );
      res.status(409).json({ error: 'CONFLICT' });
    })();
  });

  // Every statement succeeds; the COMMIT itself fails (deferred unique check).
  app.post('/api/commit-fails', (_req, res) => {
    void (async () => {
      const ctx = currentTenantContext()!;
      await ctx.client.query(`INSERT INTO ${DEFERRED_TABLE} (k) VALUES ('dup')`);
      await ctx.client.query(`INSERT INTO ${DEFERRED_TABLE} (k) VALUES ('dup')`);
      runAfterCommit(res, () => {
        afterCommitRuns.push('commit-fails');
      });
      res.status(201).json({ ok: true });
    })();
  });

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function appPool(baseUrl: string): Pool {
  const previousUrl = process.env.DATABASE_URL;
  const previousSsl = process.env.DB_SSL;
  const url = new URL(baseUrl);
  url.searchParams.set('application_name', 'rivet_1133_reqtxn');
  process.env.DATABASE_URL = url.toString();
  process.env.DB_SSL = 'false';
  try {
    return createPool();
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (previousSsl === undefined) delete process.env.DB_SSL;
    else process.env.DB_SSL = previousSsl;
  }
}

describe('#1133 — the request transaction commits before the response reaches the client', () => {
  let harnessPool: Pool;
  let realAppPool: Pool;
  let harness: Harness;
  const probes = new Map<PoolClient, WriteProbe>();
  let tenantA: string;
  let tenantB: string;
  let tenantBRowId: string;

  beforeAll(async () => {
    harnessPool = await getSharedTestDb();
    const baseUrl = process.env.TEST_DB_URL as string;
    expect(baseUrl, 'TEST_DB_URL must be set by the integration globalSetup').toBeTruthy();
    ({ tenantId: tenantA } = await createTestTenant(harnessPool));
    ({ tenantId: tenantB } = await createTestTenant(harnessPool));

    // T1 — the neighbour tenant owns divergent data the whole run must not touch.
    const { rows } = await harnessPool.query<{ id: string }>(
      `INSERT INTO dropped_call_recoveries (tenant_id, voice_session_id, caller_e164, scheduled_for)
       VALUES ($1, $2, '+15125550199', NOW()) RETURNING id`,
      [tenantB, uuidv4()],
    );
    tenantBRowId = rows[0].id;

    await harnessPool.query(`DROP TABLE IF EXISTS ${DEFERRED_TABLE}`);
    await harnessPool.query(
      `CREATE TABLE ${DEFERRED_TABLE} (
         k TEXT,
         CONSTRAINT ${DEFERRED_TABLE}_k UNIQUE (k) DEFERRABLE INITIALLY DEFERRED
       )`,
    );
    await harnessPool.query(`GRANT SELECT, INSERT, DELETE ON ${DEFERRED_TABLE} TO ${RLS_APP_ROLE}`);

    realAppPool = appPool(baseUrl);
    harness = await startHarness(instrumentedPool(realAppPool, probes), probes);
  });

  afterAll(async () => {
    await harness?.close();
    await realAppPool?.end().catch(() => undefined);
    await harnessPool.query(`DROP TABLE IF EXISTS ${DEFERRED_TABLE}`);
    await harnessPool.query('DELETE FROM dropped_call_recoveries WHERE tenant_id = ANY($1)', [
      [tenantA, tenantB],
    ]);
    await closeSharedTestDb();
  });

  afterEach(async () => {
    await harnessPool.query('DELETE FROM dropped_call_recoveries WHERE tenant_id = $1', [tenantA]);
    await harnessPool.query(`DELETE FROM ${DEFERRED_TABLE}`);
  });

  it(`a client that got the 201 can immediately read the row — ${ITERATIONS}× in a row`, async () => {
    const observations: Array<{
      createStatus: number;
      visibleToSeparateConnection: number;
      dependentReadStatus: number;
    }> = [];
    let heldCommits = 0;

    for (let i = 0; i < ITERATIONS; i += 1) {
      const probe: WriteProbe = {
        res: undefined as unknown as express.Response,
        clientDone: deferred(),
        commitSettled: deferred(),
      };
      pendingProbes.push(probe);

      const created = await fetch(`${harness.url}/api/rows`, {
        method: 'POST',
        headers: { 'x-test-tenant': tenantA },
      });
      const { id } = (await created.json()) as { id: string };

      // The instant the client holds the 201 — before anything lets the
      // request's COMMIT through — look for the row two ways.
      const { rows } = await harnessPool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM dropped_call_recoveries WHERE id = $1',
        [id],
      );
      const dependent = await fetch(`${harness.url}/api/rows/${id}`, {
        headers: { 'x-test-tenant': tenantA },
      });
      await dependent.arrayBuffer();

      observations.push({
        createStatus: created.status,
        visibleToSeparateConnection: rows[0].n,
        dependentReadStatus: dependent.status,
      });

      // Let the COMMIT through (a no-op when it already happened) and wait for
      // it, so the next iteration starts clean.
      probe.clientDone.resolve();
      await probe.commitSettled.promise;
      if (probe.heldBecauseResponseWasFlushed) heldCommits += 1;
    }

    expect(observations).toEqual(
      Array.from({ length: ITERATIONS }, () => ({
        createStatus: 201,
        visibleToSeparateConnection: 1,
        dependentReadStatus: 200,
      })),
    );
    // No COMMIT was still pending when its response had been flushed.
    expect(heldCommits).toBe(0);

    // T1 — tenant B's divergent row is untouched, B cannot see A's rows through
    // the same middleware, and B still sees its own.
    const tenantBRows = await harnessPool.query<{ id: string }>(
      'SELECT id FROM dropped_call_recoveries WHERE tenant_id = $1',
      [tenantB],
    );
    expect(tenantBRows.rows.map((r) => r.id)).toEqual([tenantBRowId]);
    const tenantARows = await harnessPool.query<{ id: string }>(
      'SELECT id FROM dropped_call_recoveries WHERE tenant_id = $1',
      [tenantA],
    );
    expect(tenantARows.rows).toHaveLength(ITERATIONS);
    const crossTenant = await fetch(`${harness.url}/api/rows/${tenantARows.rows[0].id}`, {
      headers: { 'x-test-tenant': tenantB },
    });
    expect(crossTenant.status).toBe(404);
    const ownRow = await fetch(`${harness.url}/api/rows/${tenantBRowId}`, {
      headers: { 'x-test-tenant': tenantB },
    });
    expect(ownRow.status).toBe(200);
  });

  it('a 4xx response still rolls its writes back, and they are gone when the client sees it', async () => {
    const res = await fetch(`${harness.url}/api/rows-conflict`, {
      method: 'POST',
      headers: { 'x-test-tenant': tenantA },
    });
    await res.arrayBuffer();
    expect(res.status).toBe(409);
    const { rows } = await harnessPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM dropped_call_recoveries
        WHERE tenant_id = $1 AND caller_e164 = '+15125550144'`,
      [tenantA],
    );
    expect(rows[0].n).toBe(0);
  });

  it('a COMMIT that fails is not reported to the client as a 2xx, and after-commit hooks do not run', async () => {
    afterCommitRuns.length = 0;
    const res = await fetch(`${harness.url}/api/commit-fails`, {
      method: 'POST',
      headers: { 'x-test-tenant': tenantA },
    });
    const body = await res.text();

    const { rows } = await harnessPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${DEFERRED_TABLE}`,
    );
    // Postgres rejected the COMMIT (deferred unique violation): nothing persisted…
    expect(rows[0].n).toBe(0);
    // …so the client must not be told it succeeded…
    expect({ status: res.status, body }).toMatchObject({ status: 500 });
    // …and the after-commit side effects must not have fired.
    expect(afterCommitRuns).toEqual([]);
  });
});
