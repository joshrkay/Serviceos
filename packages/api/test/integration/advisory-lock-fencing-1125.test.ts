/**
 * #1125 — a session advisory lock whose holder connection dies must FENCE the
 * critical section it was protecting.
 *
 * #1112 (`guardClientErrors`, db/pool.ts) keeps a Postgres-terminated,
 * checked-out client off `uncaughtException`. But when that client holds a
 * SESSION advisory lock, Postgres releases the lock the moment the backend
 * dies — and the holder never finds out: its work keeps going while a second
 * holder acquires the same lock and runs the same critical section.
 *
 * Every leg below reproduces that at a real Postgres, deterministically:
 *   1. holder A acquires the lock and enters its critical section, then
 *      parks on a gate;
 *   2. the test `pg_terminate_backend`s A's lock-holding backend (found via
 *      pg_locks, scoped by application_name so nothing else is touched);
 *   3. holder B acquires the SAME lock (proving Postgres released it) and
 *      runs its critical section to completion;
 *   4. A's gate opens.
 * The DESIRED outcome is that A refuses to carry on with the work the lock
 * no longer protects — B's effect happens once, A's never.
 *
 * Legs:
 *   - leader tick (`runLeaderGatedTick`, the `runAsLeader` pool path): A's
 *     post-loss write must not land, and A's tick must not count as a
 *     successful sweep.
 *   - ProposalExecutor Path B (external-I/O handler), loss DURING the
 *     handler: a handler that persists and then sends (the shape of
 *     record_payment: DB writes, then the receipt) must not send twice.
 *   - ProposalExecutor Path B, loss AFTER the idempotency check but BEFORE
 *     `handler.execute()`: the external call must not start.
 *
 * Pools for the lock holders are built by the PRODUCTION factory
 * (`createPool`), so #1112's checked-out-client guard is in place, and every
 * leg asserts nothing escapes to `uncaughtException` / `unhandledRejection`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { createPool } from '../../src/db/pool';
import { runLeaderGatedTick } from '../../src/workers/leader-tick';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createAuditEvent } from '../../src/audit/audit';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { PgIdempotencyLockProvider } from '../../src/proposals/execution/idempotency-lock';
import type { ExecutionHandler, ExecutionResult } from '../../src/proposals/execution/handlers';
import type { Proposal, ProposalType } from '../../src/proposals/proposal';
import { transitionProposal } from '../../src/proposals/lifecycle';

const APP_A = 'rivet_1125_holder_a';
const APP_B = 'rivet_1125_holder_b';

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

interface ProcessEscape {
  kind: 'uncaughtException' | 'unhandledRejection';
  message: string;
}
function captureProcessEscapes(): { escapes: ProcessEscape[]; stop: () => void } {
  const escapes: ProcessEscape[] = [];
  const onException = (err: unknown): void => {
    escapes.push({ kind: 'uncaughtException', message: err instanceof Error ? err.message : String(err) });
  };
  const onRejection = (reason: unknown): void => {
    escapes.push({ kind: 'unhandledRejection', message: reason instanceof Error ? reason.message : String(reason) });
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

/** A pool from the PRODUCTION factory, tagged so the kill below is scoped to it. */
function createAppPool(baseUrl: string, applicationName: string): Pool {
  const previousUrl = process.env.DATABASE_URL;
  const previousSsl = process.env.DB_SSL;
  const url = new URL(baseUrl);
  url.searchParams.set('application_name', applicationName);
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

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

describe('#1125 — a lost session advisory lock fences the critical section it protected', () => {
  let harness: Pool;
  let baseUrl: string;
  let poolA: Pool;
  let poolB: Pool;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    harness = await getSharedTestDb();
    baseUrl = process.env.TEST_DB_URL as string;
    expect(baseUrl, 'TEST_DB_URL must be set by the integration globalSetup').toBeTruthy();
    poolA = createAppPool(baseUrl, APP_A);
    poolB = createAppPool(baseUrl, APP_B);
    auditRepo = new PgAuditRepository(harness);
  });

  afterEach(async () => {
    await harness
      .query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ANY($1)', [[APP_A, APP_B]])
      .catch(() => undefined);
  });

  afterAll(async () => {
    await poolA.end().catch(() => undefined);
    await poolB.end().catch(() => undefined);
    await closeSharedTestDb();
  });

  /**
   * Terminate the backend of `applicationName` that currently holds a granted
   * advisory lock, then wait until Postgres has actually reaped it (so the
   * lock is free for the second holder).
   */
  async function killAdvisoryLockHolder(applicationName: string): Promise<void> {
    const { rows } = await harness.query<{ pid: number }>(
      `SELECT DISTINCT a.pid
         FROM pg_stat_activity a
         JOIN pg_locks l ON l.pid = a.pid
        WHERE a.application_name = $1 AND l.locktype = 'advisory' AND l.granted`,
      [applicationName],
    );
    expect(rows, `exactly one ${applicationName} backend holds an advisory lock`).toHaveLength(1);
    const pid = rows[0].pid;
    await harness.query('SELECT pg_terminate_backend($1)', [pid]);
    const deadline = Date.now() + 5_000;
    for (;;) {
      const alive = await harness.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid]);
      if (alive.rowCount === 0) break;
      if (Date.now() > deadline) throw new Error(`backend ${pid} still alive 5s after pg_terminate_backend`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  function tickEvent(tenantId: string, runId: string, holder: string, step: number) {
    return createAuditEvent({
      tenantId,
      actorId: 'system:test-1125',
      actorRole: 'system',
      eventType: 'test.leader_tick_effect',
      entityType: 'test_run',
      entityId: runId,
      metadata: { holder, step },
    });
  }

  it('leader tick: after its lock backend is terminated, holder A does not commit work while holder B owns the tick, and A is not a successful sweep — neighbour tenant untouched', async () => {
    const capture = captureProcessEscapes();
    try {
      const tenant = await createTestTenant(harness);
      const neighbour = await createTestTenant(harness);
      const runId = randomUUID();
      const lockKey = 1_125_000_000 + Math.floor(Math.random() * 1_000_000);

      const aEntered = deferred();
      const aGate = deferred();
      let aSuccess = 0;
      let bSuccess = 0;

      const tickA = settle(
        runLeaderGatedTick(
          poolA,
          lockKey,
          async () => {
            await auditRepo.create(tickEvent(tenant.tenantId, runId, 'A', 1));
            aEntered.resolve();
            await aGate.promise;
            // The protected effect A would commit AFTER its lock is gone.
            await auditRepo.create(tickEvent(tenant.tenantId, runId, 'A', 2));
          },
          () => {
            aSuccess += 1;
          },
        ),
      );

      await aEntered.promise;
      await killAdvisoryLockHolder(APP_A);

      // Holder B (another replica) gets the SAME lock — Postgres released it.
      let bRan = false;
      await runLeaderGatedTick(
        poolB,
        lockKey,
        async () => {
          bRan = true;
          await auditRepo.create(tickEvent(tenant.tenantId, runId, 'B', 1));
        },
        () => {
          bSuccess += 1;
        },
      );
      expect(bRan).toBe(true);

      aGate.resolve();
      const outcomeA = await tickA;

      const rows = await auditRepo.findByEntity(tenant.tenantId, 'test_run', runId);
      const effects = rows.map((r) => `${r.metadata.holder}:${r.metadata.step}`).sort();
      // DESIRED: A's step-2 write never lands once A lost the lock.
      expect(effects).toEqual(['A:1', 'B:1']);
      expect(bSuccess).toBe(1);
      expect(aSuccess).toBe(0);
      expect(outcomeA.ok).toBe(false);
      expect((outcomeA as { ok: false; error: { code?: string } }).error.code).toBe('SESSION_LEASE_LOST');

      // Neighbour tenant: no effect rows of this run.
      expect(await auditRepo.findByEntity(neighbour.tenantId, 'test_run', runId)).toEqual([]);
      expect(capture.escapes).toEqual([]);
    } finally {
      capture.stop();
    }
  });

  async function approvedProposal(tenantId: string, userId: string): Promise<Proposal> {
    const proposalRepo = new PgProposalRepository(harness);
    let proposal = await proposalRepo.create({
      tenantId,
      proposalType: 'create_customer',
      payload: { name: 'Fencing Test' },
      summary: 'fencing',
      createdBy: userId,
      idempotencyKey: `fence-1125-${randomUUID()}`,
    } as unknown as Proposal);
    proposal = transitionProposal(proposal, 'ready_for_review', 'test');
    proposal = transitionProposal(proposal, 'approved', 'test');
    return { ...proposal, approvedAt: new Date(Date.now() - 10_000) };
  }

  function executorOn(
    lockPool: Pool,
    handler: ExecutionHandler,
    executionRepo: PgProposalExecutionRepository = new PgProposalExecutionRepository(harness),
  ): ProposalExecutor {
    const proposalRepo = new PgProposalRepository(harness);
    const handlers = new Map<ProposalType, ExecutionHandler>([['create_customer', handler]]);
    const guard = new IdempotencyGuard(executionRepo, proposalRepo, new PgIdempotencyLockProvider(lockPool));
    return new ProposalExecutor(handlers, proposalRepo, guard, auditRepo, { executionRepo });
  }

  it('executor Path B: the lock backend dies DURING an external-I/O handler that persists then sends — the send happens exactly once (B), not again when A resumes; neighbour tenant untouched', async () => {
    const capture = captureProcessEscapes();
    try {
      const tenant = await createTestTenant(harness);
      const neighbour = await createTestTenant(harness);
      const proposal = await approvedProposal(tenant.tenantId, tenant.userId);
      const neighbourProposal = await approvedProposal(neighbour.tenantId, neighbour.userId);

      let invocations = 0;
      let sends = 0;
      const aEntered = deferred();
      const aGate = deferred();
      const handler: ExecutionHandler = {
        proposalType: 'create_customer',
        performsExternalIo: true,
        async execute(p: Proposal): Promise<ExecutionResult> {
          invocations += 1;
          if (invocations === 1) {
            aEntered.resolve();
            await aGate.promise;
          }
          // Persist first (record_payment's recordPayment writes) …
          await auditRepo.create(
            createAuditEvent({
              tenantId: p.tenantId,
              actorId: 'system:test-1125',
              actorRole: 'system',
              eventType: 'test.handler_persist',
              entityType: 'proposal',
              entityId: p.id,
              metadata: { invocation: invocations },
            }),
          );
          // … then the external send (the receipt SMS / charge).
          sends += 1;
          return { success: true, resultEntityId: randomUUID() };
        },
      };

      const ctx = { tenantId: tenant.tenantId, executedBy: tenant.userId };
      const runA = settle(executorOn(poolA, handler).execute(proposal, ctx));
      await aEntered.promise;
      await killAdvisoryLockHolder(APP_A);

      const runB = await executorOn(poolB, handler).execute(proposal, ctx);
      expect(runB.result.success).toBe(true);
      expect(sends).toBe(1);

      aGate.resolve();
      const outcomeA = await runA;

      // DESIRED: the external send happened once.
      expect(sends).toBe(1);
      expect(outcomeA.ok).toBe(false);
      expect((outcomeA as { ok: false; error: { code?: string } }).error.code).toBe('SESSION_LEASE_LOST');

      const executionRepo = new PgProposalExecutionRepository(harness);
      const rows = await executionRepo.listByProposal(tenant.tenantId, proposal.id);
      expect(rows.filter((r) => r.status === 'succeeded')).toHaveLength(1);
      const stored = await new PgProposalRepository(harness).findById(tenant.tenantId, proposal.id);
      expect(stored!.status).toBe('executed');

      // Neighbour tenant: its approved proposal was never executed or recorded.
      expect(await executionRepo.listByProposal(neighbour.tenantId, neighbourProposal.id)).toEqual([]);
      expect(capture.escapes).toEqual([]);
    } finally {
      capture.stop();
    }
  });

  it('executor Path B: the lock backend dies after the idempotency check but before handler.execute() — the external call never starts for A; neighbour tenant untouched', async () => {
    const capture = captureProcessEscapes();
    try {
      const tenant = await createTestTenant(harness);
      const neighbour = await createTestTenant(harness);
      const proposal = await approvedProposal(tenant.tenantId, tenant.userId);
      const neighbourProposal = await approvedProposal(neighbour.tenantId, neighbour.userId);

      const aChecked = deferred();
      const aGate = deferred();
      let gateNext = true;
      // Executor A's idempotency lookup runs, THEN parks — so A has already
      // seen "not executed yet" when its lock dies.
      class ParkingExecutionRepository extends PgProposalExecutionRepository {
        override async findByIdempotencyKey(tenantId: string, key: string) {
          const found = await super.findByIdempotencyKey(tenantId, key);
          if (gateNext) {
            gateNext = false;
            aChecked.resolve();
            await aGate.promise;
          }
          return found;
        }
      }

      let sends = 0;
      const handler: ExecutionHandler = {
        proposalType: 'create_customer',
        performsExternalIo: true,
        async execute(): Promise<ExecutionResult> {
          sends += 1; // the external call itself
          return { success: true, resultEntityId: randomUUID() };
        },
      };

      const ctx = { tenantId: tenant.tenantId, executedBy: tenant.userId };
      const runA = settle(
        executorOn(poolA, handler, new ParkingExecutionRepository(harness)).execute(proposal, ctx),
      );
      await aChecked.promise;
      await killAdvisoryLockHolder(APP_A);

      const runB = await executorOn(poolB, handler).execute(proposal, ctx);
      expect(runB.result.success).toBe(true);
      expect(sends).toBe(1);

      aGate.resolve();
      const outcomeA = await runA;

      // DESIRED: A never started its external call.
      expect(sends).toBe(1);
      expect(outcomeA.ok).toBe(false);
      expect((outcomeA as { ok: false; error: { code?: string } }).error.code).toBe('SESSION_LEASE_LOST');

      const executionRepo = new PgProposalExecutionRepository(harness);
      const rows = await executionRepo.listByProposal(tenant.tenantId, proposal.id);
      expect(rows.filter((r) => r.status === 'succeeded')).toHaveLength(1);
      expect(await executionRepo.listByProposal(neighbour.tenantId, neighbourProposal.id)).toEqual([]);
      expect(capture.escapes).toEqual([]);
    } finally {
      capture.stop();
    }
  });
});
