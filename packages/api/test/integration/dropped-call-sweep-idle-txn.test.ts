/**
 * #1090 — a Postgres-terminated connection must never take the API process
 * down, and the dropped-call sweep must survive its own infrastructure
 * failing underneath it.
 *
 * Three properties, each pinned against a REAL Postgres because a mocked pool
 * cannot reproduce any of them:
 *
 *   1. A pooled connection that Postgres terminates WHILE IT IS CHECKED OUT
 *      (idle-in-transaction timeout — the exact production trigger: the
 *      request middleware sets `idle_in_transaction_session_timeout` LOCAL to
 *      every request transaction, and managed providers set it server-side)
 *      raises on `pg.Client` as an EventEmitter `'error'` event, NOT as a
 *      rejected query promise: `pg/lib/client.js` `_handleErrorMessage` routes
 *      a backend ErrorResponse with no active query to `_handleErrorEvent`,
 *      which does `this.emit('error', err)`. `pg-pool` removes its only
 *      `'error'` listener while a client is checked out
 *      (`pg-pool/index.js` `_acquireClient`: `client.removeListener('error',
 *      idleListener)`), so the event is unhandled and Node re-throws it as an
 *      `uncaughtException` — which index.ts treats as FATAL and shuts the
 *      process down. No try/catch on the await path can ever see it.
 *
 *   2. The sweep keeps running while a connection it holds across the
 *      compose/send network calls is terminated server-side, and still
 *      completes its batch.
 *
 *   3. When the pool is torn down underneath an in-flight sweep (the
 *      shutdown race that produced `Cannot use a pool after calling end on
 *      the pool` in the incident log), the sweep reports the failure PER
 *      TENANT, returns normally, and lets no rejection escape.
 *
 * Every test asserts on process-level `uncaughtException` /
 * `unhandledRejection` listeners attached inside the test, so "the process
 * stays up" is an assertion rather than an inference.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { createPool } from '../../src/db/pool';
import { runDroppedCallRecoverySweep } from '../../src/workers/dropped-call-worker';
import { PgDroppedCallRecoveryRepository } from '../../src/sms/recovery/scheduler';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import type { Logger } from '../../src/logging/logger';
import type {
  DroppedCallHandlerDeps,
  RecoveryRateLimiter,
  ResolvedSinceChecker,
} from '../../src/sms/recovery/dropped-call-handler';

const APP_NAME = 'rivet_1090_sweep_test';
const SCHEDULED_FOR = new Date(Date.now() - 2 * 60_000);
const DUE_AT = new Date();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface LoggedLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
}

function capturingLogger(lines: LoggedLine[]): Logger {
  const push = (level: LoggedLine['level']) => (message: string, meta?: Record<string, unknown>) => {
    lines.push({ level, message, ...(meta ? { meta } : {}) });
  };
  const logger: Logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  };
  return logger;
}

interface ProcessEscape {
  kind: 'uncaughtException' | 'unhandledRejection';
  message: string;
}

/**
 * Attach our own process handlers for the duration of a test. Note the
 * side effect that makes this a fair test rather than a self-fulfilling one:
 * having a listener attached means Node will NOT tear the worker down, so a
 * RED run reports the escape as a failed assertion (the captured array is
 * non-empty) instead of killing the test runner. What is asserted is exactly
 * what index.ts's `process.on('uncaughtException')` would have seen.
 */
function captureProcessEscapes(): { escapes: ProcessEscape[]; stop: () => void } {
  const escapes: ProcessEscape[] = [];
  const onException = (err: unknown): void => {
    escapes.push({
      kind: 'uncaughtException',
      message: err instanceof Error ? err.message : String(err),
    });
  };
  const onRejection = (reason: unknown): void => {
    escapes.push({
      kind: 'unhandledRejection',
      message: reason instanceof Error ? reason.message : String(reason),
    });
  };
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  return {
    escapes,
    stop: () => {
      process.off('uncaughtException', onException);
      process.off('unhandledRejection', onRejection);
    },
  };
}

/**
 * A pool built by the PRODUCTION factory (`createPool`) — the fix belongs
 * there, so the test must not hand-roll a `new Pool(...)`. `application_name`
 * scopes the `pg_terminate_backend` below to this pool's own backends so the
 * test can never kill the shared harness connection.
 */
function createAppPool(baseUrl: string): Pool {
  const previousUrl = process.env.DATABASE_URL;
  const previousSsl = process.env.DB_SSL;
  const url = new URL(baseUrl);
  url.searchParams.set('application_name', APP_NAME);
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

function makeHandlerDeps(opts: {
  audit: PgAuditRepository;
  logger: Logger;
  onSend?: () => Promise<void>;
}): Omit<DroppedCallHandlerDeps, 'repo'> {
  const rateLimit: RecoveryRateLimiter = {
    async check() {
      return true;
    },
    async record() {
      /* no-op */
    },
  };
  const resolvedSince: ResolvedSinceChecker = async () => null;
  let sendCounter = 0;
  return {
    audit: opts.audit,
    logger: opts.logger,
    rateLimit,
    resolvedSince,
    compose: async () => 'Hi — this is Test Shop. We got cut off; reply to pick back up.',
    sendSms: async () => {
      if (opts.onSend) await opts.onSend();
      sendCounter += 1;
      return `SM_1090_${sendCounter}`;
    },
    thread: async () => {
      /* threading is proven by dropped-call-worker.test.ts */
    },
    now: () => DUE_AT,
  };
}

describe('#1090 — dropped-call sweep must not crash the process on a dead connection', () => {
  let harness: Pool;
  let baseUrl: string;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    harness = await getSharedTestDb();
    baseUrl = process.env.TEST_DB_URL as string;
    expect(baseUrl, 'TEST_DB_URL must be set by the integration globalSetup').toBeTruthy();
    for (let i = 0; i < 3; i++) {
      const { tenantId } = await createTestTenant(harness);
      tenantIds.push(tenantId);
    }
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  beforeEach(async () => {
    // The sweep is cross-tenant by construction, so `due` is only assertable
    // if the queue is empty of OTHER files' leftovers too (one container is
    // shared across the whole integration run).
    await harness.query('DELETE FROM dropped_call_recoveries');
  });

  afterEach(async () => {
    // Never leave a terminated-backend test bleeding into the next one.
    await harness
      .query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1', [
        APP_NAME,
      ])
      .catch(() => undefined);
  });

  async function seedDueRow(tenantId: string): Promise<void> {
    await harness.query(
      `INSERT INTO dropped_call_recoveries (tenant_id, voice_session_id, caller_e164, scheduled_for)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, uuidv4(), '+15125550142', SCHEDULED_FOR],
    );
  }

  it('a checked-out connection killed by idle-in-transaction timeout never reaches uncaughtException', async () => {
    const capture = captureProcessEscapes();
    const pool = createAppPool(baseUrl);
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      // The production trigger, verbatim: middleware/tenant-context.ts sets
      // this GUC LOCAL to every request transaction (60s by default), and
      // managed Postgres sets it server-side. 300ms just makes the kill
      // deterministic instead of a minute-long wait.
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '300ms'");
      // The transaction now sits idle — exactly the state a handler awaiting a
      // slow upstream (or a sweep awaiting a send) leaves it in. Postgres sends
      // a FATAL ErrorResponse and closes the socket with NO query in flight.
      await sleep(1500);

      // The backend is gone. Two things must hold.
      // (a) Nothing escaped to the process — this is the FATAL in the incident.
      expect(capture.escapes).toEqual([]);
      // (b) The next query still rejects normally, so ordinary caller
      //     try/catch keeps working (we must not swallow real query errors).
      await expect(client.query('SELECT 1')).rejects.toThrow();
    } finally {
      client?.release();
      await sleep(100);
      const trailing = [...capture.escapes];
      capture.stop();
      await pool.end().catch(() => undefined);
      // The socket-close event (`Connection terminated unexpectedly`) is the
      // SECOND emit in the incident log — it must not escape either.
      expect(trailing).toEqual([]);
    }
  });

  it('the sweep completes its batch when a connection it holds across the send is terminated', async () => {
    const capture = captureProcessEscapes();
    const pool = createAppPool(baseUrl);
    const lines: LoggedLine[] = [];
    const logger = capturingLogger(lines);
    for (const tenantId of tenantIds) await seedDueRow(tenantId);

    // app.ts's runAsLeader holds a pooled connection (session advisory lock)
    // across the WHOLE sweep, including the compose/send network calls. Model
    // that here, then have the server terminate it mid-send.
    const leader = await pool.connect();
    try {
      await leader.query('SELECT pg_try_advisory_lock($1) AS locked', [590022]);

      let killed = false;
      const repo = new PgDroppedCallRecoveryRepository(pool);
      const audit = new PgAuditRepository(pool);
      const result = await runDroppedCallRecoverySweep({
        repo,
        handlerDeps: makeHandlerDeps({
          audit,
          logger,
          onSend: async () => {
            if (killed) return;
            killed = true;
            // Server-side termination of every backend this pool owns — the
            // held leader connection included. Same shape as a provider's
            // idle/admin timeout firing while the sweep awaits Twilio.
            await harness.query(
              'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1',
              [APP_NAME],
            );
            await sleep(300);
          },
        }),
        logger,
        now: () => DUE_AT,
      });

      await sleep(200);
      expect(capture.escapes).toEqual([]);
      // The sweep must still have drained its batch rather than dying.
      expect(result.due).toBe(tenantIds.length);
      expect(result.sent + result.failed).toBe(tenantIds.length);
    } finally {
      capture.stop();
      leader.release();
      await pool.end().catch(() => undefined);
    }
  });

  it('reports the failure per tenant (and throws nothing) when the pool is ended mid-sweep', async () => {
    const capture = captureProcessEscapes();
    const pool = createAppPool(baseUrl);
    const lines: LoggedLine[] = [];
    const logger = capturingLogger(lines);
    for (const tenantId of tenantIds) await seedDueRow(tenantId);

    const repo = new PgDroppedCallRecoveryRepository(pool);
    const audit = new PgAuditRepository(pool);
    let ended = false;

    const result = await runDroppedCallRecoverySweep({
      repo,
      handlerDeps: makeHandlerDeps({
        audit,
        logger,
        onSend: async () => {
          if (ended) return;
          ended = true;
          // The incident's third symptom: index.ts's fatal handler runs
          // app.gracefulDrain, which calls pool.end() while this sweep is
          // still mid-flight. Every later repo call then throws
          // "Cannot use a pool after calling end on the pool".
          await pool.end();
        },
      }),
      logger,
      now: () => DUE_AT,
    });

    await sleep(150);
    capture.stop();

    expect(capture.escapes).toEqual([]);
    // One warn per tenant row, each naming its tenant — the sweep reports,
    // it does not throw.
    const rowFailures = lines.filter((l) => l.message === 'dropped-call sweep: row failed');
    expect(rowFailures).toHaveLength(tenantIds.length);
    expect(new Set(rowFailures.map((l) => l.meta?.tenantId))).toEqual(new Set(tenantIds));
    expect(result.failed).toBe(tenantIds.length);
    expect(result.sent).toBe(0);
  });
});
