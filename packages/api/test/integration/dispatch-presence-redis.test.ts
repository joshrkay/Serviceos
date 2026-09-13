/**
 * §8.4 row 4.3 — "Given two users, when both act, then revision tokens order
 * the writes and presence shows who holds which card" (issue #1017).
 *
 * The mocked-ioredis suite (test/dispatch/redis-presence-store.test.ts) pins
 * RedisDispatchPresenceStore's shape against a scripted fake — §12.4d: mocks
 * are never the only proof. This file drives the REAL class
 * (src/dispatch/redis-presence-store.ts) against a REAL `redis:7-alpine`
 * testcontainer, through TWO independent ioredis connections (simulating two
 * API replicas each backing one user's browser — the same "two-instance, one
 * Redis" shape as redis-tenant-quota-two-instance.test.ts and
 * board-fanout-two-instance.test.ts), and drives the revision-token half
 * (`If-Match` / `appointmentVersion` on `POST /api/proposals`,
 * src/proposals/create-scheduling.ts:53-56) against REAL Postgres via the
 * real HTTP route (createProposalsRouter) and the real execution handler
 * (RescheduleAppointmentExecutionHandler → updateAppointment, which stamps
 * `updated_at = new Date()` — src/appointments/appointment.ts:314).
 *
 * What's real vs. simulated, spelled out (§12.4d honesty):
 *   - Redis: REAL (testcontainer, two ioredis TCP connections, real
 *     HSET/HGETALL/PEXPIRE — no mock).
 *   - Postgres: REAL (the shared integration-suite testcontainer via
 *     TEST_DB_URL / EXTERNAL_TEST_DB_URL — same one every other file in this
 *     directory uses).
 *   - The proposal-execution idempotency guard/execution-repo below is
 *     IN-MEMORY (InMemoryProposalExecutionRepository), matching the
 *     established precedent in test/integration/auto-pick-appointment-920.test.ts
 *     (`executeApproved`) — only the appointment row and the proposal row
 *     are real Postgres; the executor's own bookkeeping table is not.
 *   - "Two users" are two authenticated Express requests (stamped
 *     `req.auth`) against the real router, exactly like
 *     test/integration/dispatch-drag-proposal.test.ts (row 4.2, same issue)
 *     — no browser is opened in this file; the browser leg lives in
 *     e2e/journeys/dispatch-presence.spec.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import Redis from 'ioredis';
import { Pool } from 'pg';
import request from 'supertest';
import express, { Response, NextFunction } from 'express';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgWorkingHoursRepository } from '../../src/availability/pg-working-hours';
import { PgUnavailableBlockRepository } from '../../src/availability/pg-unavailable-block';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { createProposalsRouter } from '../../src/routes/proposals';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { RedisDispatchPresenceStore } from '../../src/dispatch/redis-presence-store';
import { findEditingOnAppointment } from '../../src/dispatch/presence-store';
import { approveProposal } from '../../src/proposals/actions';
import { InMemoryProposalRepository, type Proposal } from '../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { createExecutionHandlerRegistry, type ExecutionContext } from '../../src/proposals/execution/handlers';
import { UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';

const NOW = new Date('2026-09-12T14:00:00.000Z');
const BOARD_DATE = '2026-09-12';

describe('Real Redis + real Postgres — dispatch presence & revision-token ordering (row 4.3)', () => {
  let redisContainer: StartedTestContainer;
  let redisUrl: string;
  // Two independent ioredis TCP connections to the SAME container, wrapped in
  // two independent store instances — mirrors two API replicas, one per user's
  // browser session, sharing nothing except the Redis they both talk to.
  let clientForUser1: Redis;
  let clientForUser2: Redis;
  let storeForUser1: RedisDispatchPresenceStore;
  let storeForUser2: RedisDispatchPresenceStore;

  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;
  let feasibilityDeps: FeasibilityDependencies;

  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let appointmentId: string; // tenant A's card — used for BOTH the presence half and the revision-token half
  let appointmentBefore: { updatedAt: string };

  async function seedTenantFixture(tenantId: string, userId: string, label: string) {
    const jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: 'Test',
      lastName: label,
      displayName: `Test ${label}`,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId,
      customerId,
      street1: '1 Test St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      addressType: 'service',
      isPrimary: true,
      isArchived: false,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-PRESENCE-${label}`,
      summary: 'Presence/revision-token test job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: userId,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const techId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role)
       VALUES ($1, $2, $3, $4, 'technician')`,
      [techId, tenantId, techId, `${label.toLowerCase()}-presence@example.com`],
    );

    const apptId = crypto.randomUUID();
    await appointmentRepo.create({
      id: apptId,
      tenantId,
      jobId,
      scheduledStart: new Date(NOW.getTime() + 60 * 60 * 1000),
      scheduledEnd: new Date(NOW.getTime() + 2 * 60 * 60 * 1000),
      timezone: 'UTC',
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: userId,
      createdAt: NOW,
      updatedAt: NOW,
    });

    await assignmentRepo.create({
      id: crypto.randomUUID(),
      tenantId,
      appointmentId: apptId,
      technicianId: techId,
      isPrimary: true,
      assignedBy: userId,
      assignedAt: NOW,
    });

    return { apptId };
  }

  function appFor(tenantId: string, userId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId,
        sessionId: `sess-${userId}`,
        tenantId,
        role: 'owner',
      };
      next();
    });
    app.use(
      '/api/proposals',
      createProposalsRouter(proposalRepo, appointmentRepo, auditRepo, feasibilityDeps),
    );
    return app;
  }

  /** Real execution: approves + runs RescheduleAppointmentExecutionHandler for
   *  real against real Postgres (appointmentRepo), bumping `updated_at`. The
   *  idempotency guard + the proposal's OWN execution bookkeeping are
   *  in-memory (same precedent as auto-pick-appointment-920.test.ts's
   *  `executeApproved`) — see file doc-comment for exactly what that means. */
  async function approveAndExecute(tenantId: string, actorId: string, proposal: { id: string }) {
    const approved = await approveProposal(proposalRepo, tenantId, proposal.id, actorId, 'owner');

    const executionProposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const handlers = createExecutionHandlerRegistry({ appointmentRepo, assignmentRepo, auditRepo, feasibilityDeps });
    const guard = new IdempotencyGuard(executionRepo, executionProposalRepo);
    const executor = new ProposalExecutor(handlers, executionProposalRepo, guard, auditRepo);
    // Undo window must have closed before the executor will act on it.
    const ready: Proposal = { ...approved, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await executionProposalRepo.create(ready);
    const context: ExecutionContext = { tenantId, executedBy: actorId };
    const { result } = await executor.execute(ready, context);
    return result;
  }

  beforeAll(async () => {
    // ── Real Redis testcontainer (DOCKER_HOST honored via env — see lane
    //    preamble; testcontainers reads it automatically). ──────────────────
    redisContainer = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    const redisHost = redisContainer.getHost();
    const redisPort = redisContainer.getMappedPort(6379);
    redisUrl = `redis://${redisHost}:${redisPort}`;

    clientForUser1 = new Redis(redisUrl);
    clientForUser2 = new Redis(redisUrl);
    storeForUser1 = new RedisDispatchPresenceStore(clientForUser1);
    storeForUser2 = new RedisDispatchPresenceStore(clientForUser2);

    // ── Real Postgres (shared testcontainer, same as every other file here). ─
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);

    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);

    const fixtureA = await seedTenantFixture(tenantA.tenantId, tenantA.userId, 'A');
    appointmentId = fixtureA.apptId;
    await seedTenantFixture(tenantB.tenantId, tenantB.userId, 'B');

    feasibilityDeps = {
      assignmentRepo,
      appointmentRepo,
      jobRepo: new PgJobRepository(pool),
      locationRepo: new PgLocationRepository(pool),
      workingHoursRepo: new PgWorkingHoursRepository(pool),
      unavailableBlockRepo: new PgUnavailableBlockRepository(pool),
      travelTimeProvider: new HaversineFallbackProvider(),
      skillMatcher: new StubSkillMatcher(),
    };

    const before = await appointmentRepo.findById(tenantA.tenantId, appointmentId);
    appointmentBefore = { updatedAt: before!.updatedAt.toISOString() };
  }, 120_000);

  afterAll(async () => {
    await clientForUser1?.quit();
    await clientForUser2?.quit();
    await redisContainer?.stop();
    await closeSharedTestDb();
  });

  it('two users of tenant A take/hold/release the SAME card — the second holder sees the first over REAL Redis', async () => {
    // User 1 picks up the card (drag start) — written through THEIR connection.
    const changed = await storeForUser1.upsert({
      tenantId: tenantA.tenantId,
      date: BOARD_DATE,
      userId: tenantA.userId,
      displayName: 'User One',
      appointmentId,
      mode: 'dragging',
    });
    expect(changed).toBe(true);

    // Raw proof at the Redis wire level — a real HGETALL on the real key,
    // read over a DIFFERENT ioredis connection than the one that wrote it.
    const rawHash = await clientForUser2.hgetall(`dispatch:presence:${tenantA.tenantId}:${BOARD_DATE}`);
    expect(Object.keys(rawHash)).toEqual([tenantA.userId]);
    expect(JSON.parse(rawHash[tenantA.userId])).toMatchObject({ mode: 'dragging', appointmentId });

    // User 2 — a SEPARATE store instance over a SEPARATE Redis connection —
    // sees User 1 holding the card. This is exactly `findEditingOnAppointment`,
    // the function board-query.ts embeds into every appointment as `.editing`.
    const secondUserId = crypto.randomUUID();
    const listedByUser2 = await storeForUser2.list(tenantA.tenantId, BOARD_DATE);
    expect(listedByUser2).toHaveLength(1);
    expect(listedByUser2[0]).toMatchObject({
      userId: tenantA.userId,
      appointmentId,
      mode: 'dragging',
    });
    const heldBy = findEditingOnAppointment(listedByUser2, appointmentId, secondUserId);
    expect(heldBy).toEqual({ userId: tenantA.userId, displayName: 'User One', mode: 'dragging' });

    // User 1 releases (drop / cancel) — cleared through their OWN connection.
    const cleared = await storeForUser1.clear(tenantA.tenantId, BOARD_DATE, tenantA.userId);
    expect(cleared).toBe(true);

    // The release is visible from User 2's connection immediately (shared
    // Redis, not a per-replica cache) — the hold is gone, cluster-wide.
    expect(await storeForUser2.list(tenantA.tenantId, BOARD_DATE)).toHaveLength(0);
    const rawAfterClear = await clientForUser2.hgetall(`dispatch:presence:${tenantA.tenantId}:${BOARD_DATE}`);
    expect(rawAfterClear).toEqual({});
  });

  it('TTL/lease expiry releases the hold without an explicit clear, at real Redis (not simulated fake timers)', async () => {
    const cardId = crypto.randomUUID();
    await storeForUser1.upsert({
      tenantId: tenantA.tenantId,
      date: BOARD_DATE,
      userId: tenantA.userId,
      displayName: 'User One',
      appointmentId: cardId,
      mode: 'dragging',
      ttlMs: 300,
    });
    expect(await storeForUser2.list(tenantA.tenantId, BOARD_DATE)).toHaveLength(1);

    // Real wall-clock wait — no vi.useFakeTimers here, this is real Redis
    // wall-clock lease expiry (the stored payload's own `expiresAt`, checked
    // against Date.now() on read — redis-presence-store.ts list()).
    await new Promise((r) => setTimeout(r, 600));

    const listedAfterExpiry = await storeForUser2.list(tenantA.tenantId, BOARD_DATE);
    expect(listedAfterExpiry).toHaveLength(0);
    // Best-effort purge already ran on that read — confirm the field itself
    // is gone from the real hash, not just filtered client-side.
    const raw = await clientForUser1.hgetall(`dispatch:presence:${tenantA.tenantId}:${BOARD_DATE}`);
    expect(raw[tenantA.userId]).toBeUndefined();
  });

  it('T2 — tenant B\'s presence NEVER appears under tenant A\'s key, even for the identical card id with a different holder', async () => {
    const sharedCardId = 'shared-card-id-across-tenants';

    await storeForUser1.upsert({
      tenantId: tenantA.tenantId,
      date: BOARD_DATE,
      userId: tenantA.userId,
      displayName: 'Tenant A holder',
      appointmentId: sharedCardId,
      mode: 'dragging',
    });
    await storeForUser2.upsert({
      tenantId: tenantB.tenantId,
      date: BOARD_DATE,
      userId: tenantB.userId,
      displayName: 'Tenant B holder',
      appointmentId: sharedCardId,
      mode: 'dragging',
    });

    const listA = await storeForUser1.list(tenantA.tenantId, BOARD_DATE);
    const listB = await storeForUser2.list(tenantB.tenantId, BOARD_DATE);

    expect(listA.map((e) => e.userId)).toEqual([tenantA.userId]);
    expect(listB.map((e) => e.userId)).toEqual([tenantB.userId]);
    expect(listA.some((e) => e.userId === tenantB.userId), 'tenant A must never see tenant B\'s holder').toBe(false);
    expect(listB.some((e) => e.userId === tenantA.userId), 'tenant B must never see tenant A\'s holder').toBe(false);

    // Direct proof at the Redis key level: two SEPARATE hashes, never one
    // shared hash keyed only by userId/appointmentId.
    const rawA = await clientForUser1.hgetall(`dispatch:presence:${tenantA.tenantId}:${BOARD_DATE}`);
    const rawB = await clientForUser1.hgetall(`dispatch:presence:${tenantB.tenantId}:${BOARD_DATE}`);
    expect(Object.keys(rawA)).toEqual([tenantA.userId]);
    expect(Object.keys(rawB)).toEqual([tenantB.userId]);

    // cleanup so later tests in this file see a clean slate for this card
    await storeForUser1.clear(tenantA.tenantId, BOARD_DATE, tenantA.userId);
    await storeForUser2.clear(tenantB.tenantId, BOARD_DATE, tenantB.userId);
  });

  it('revision tokens order two writes: user 2\'s stale appointmentVersion is rejected 409 at real Postgres, after user 1\'s write really landed', async () => {
    const app = appFor(tenantA.tenantId, tenantA.userId);
    const v0 = appointmentBefore.updatedAt;

    // ── User 1 acts first: creates a reschedule proposal against v0 ─────────
    const newStart1 = new Date(NOW.getTime() + 5 * 60 * 60 * 1000).toISOString();
    const newEnd1 = new Date(NOW.getTime() + 6 * 60 * 60 * 1000).toISOString();
    const res1 = await request(app)
      .post('/api/proposals')
      .set('If-Match', v0)
      .send({
        proposalType: 'reschedule_appointment',
        payload: { appointmentId, newScheduledStart: newStart1, newScheduledEnd: newEnd1, reason: 'user 1 write' },
        summary: 'User 1 reschedule',
      });
    expect(res1.status, `user 1 create -> ${JSON.stringify(res1.body)}`).toBe(200);
    expect(res1.body.status).toBe('draft');

    // ── User 1's write REALLY lands: approve + execute for real, against
    //    real Postgres — this is what actually orders the writes; the
    //    version token is `appointments.updated_at`, stamped by
    //    updateAppointment (src/appointments/appointment.ts) via a real SQL
    //    UPDATE, not a test-injected value. ──────────────────────────────────
    const execResult = await approveAndExecute(tenantA.tenantId, tenantA.userId, res1.body);
    expect(execResult.success, `execution failed: ${JSON.stringify(execResult)}`).toBe(true);

    const afterUser1Write = await appointmentRepo.findById(tenantA.tenantId, appointmentId);
    expect(afterUser1Write!.scheduledStart.toISOString()).toBe(newStart1);
    const v1 = afterUser1Write!.updatedAt.toISOString();
    expect(v1, 'the real write must actually advance the version token').not.toBe(v0);

    // ── User 2 acted concurrently: their browser still holds v0 (the
    //    version the board handed them BEFORE user 1's write landed) and
    //    tries to move the SAME card. The ordering guarantee is that this
    //    write is REJECTED, not silently applied over user 1's change. ──────
    const newStart2 = new Date(NOW.getTime() + 7 * 60 * 60 * 1000).toISOString();
    const newEnd2 = new Date(NOW.getTime() + 8 * 60 * 60 * 1000).toISOString();
    const res2 = await request(app)
      .post('/api/proposals')
      .set('If-Match', v0) // deliberately stale — user 2 never saw v1
      .send({
        proposalType: 'reschedule_appointment',
        payload: { appointmentId, newScheduledStart: newStart2, newScheduledEnd: newEnd2, reason: 'user 2 write, stale' },
        summary: 'User 2 reschedule (stale)',
      });
    expect(res2.status, `user 2's stale write must be rejected -> ${JSON.stringify(res2.body)}`).toBe(409);
    expect(res2.body.error).toBe('STALE_APPOINTMENT');
    expect(res2.body.currentVersion).toBe(v1);
    expect(res2.body.providedVersion).toBe(v0);

    // The appointment itself is untouched by the rejected write — still at
    // user 1's applied schedule, not user 2's.
    const afterRejection = await appointmentRepo.findById(tenantA.tenantId, appointmentId);
    expect(afterRejection!.scheduledStart.toISOString()).toBe(newStart1);
    expect(afterRejection!.updatedAt.toISOString()).toBe(v1);

    // ── User 2, now refetching (as the real board's 409 handler does — see
    //    packages/web/src/pages/dispatch/DispatchBoard.tsx:600-604), gets
    //    the fresh v1 and can re-propose successfully against it. This is
    //    the "ordering" half proven end to end: user 2's write is not lost,
    //    it is correctly SEQUENCED after user 1's. ────────────────────────
    const res3 = await request(app)
      .post('/api/proposals')
      .set('If-Match', v1)
      .send({
        proposalType: 'reschedule_appointment',
        payload: { appointmentId, newScheduledStart: newStart2, newScheduledEnd: newEnd2, reason: 'user 2 write, re-based on v1' },
        summary: 'User 2 reschedule (re-based)',
      });
    expect(res3.status, `user 2's re-based write -> ${JSON.stringify(res3.body)}`).toBe(200);
    expect(res3.body.status).toBe('draft');
  });
});
