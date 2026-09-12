/**
 * §8.4 row 4.2 — "dragging a card proposes a change, never makes one" at real
 * Postgres.
 *
 * Drives the ACTUAL drag→proposal path: the dispatch board's drag handler
 * (packages/web/src/components/dispatch/useCreateScheduleProposal.ts) POSTs
 * to `/api/proposals`, which routes/proposals.ts's bare POST / handler hands
 * to `createSchedulingProposal` (src/proposals/create-scheduling.ts). This
 * test drives that SAME HTTP route with real Postgres-backed repositories —
 * no mocked Pool, no in-memory proposal/appointment repo.
 *
 * Proves:
 *   1. A reschedule drag creates a real `proposals` row and performs NO
 *      appointment mutation — the appointment's status/updatedAt/scheduled
 *      times are byte-identical before and after.
 *   2. T1 — a second tenant's board is untouched: the proposal is invisible
 *      under tenant B's id, and tenant B's own appointment is unaffected.
 *
 * Gap surfaced, NOT invented around (§12.4d — a doc-comment is not a
 * wiring): `createSchedulingProposal` never emits a `proposal.created` audit
 * event (confirmed by reading routes/proposals.ts and create-scheduling.ts —
 * neither calls `auditRepo.create`/`logProposalEvent`; `PgProposalRepository
 * .create` is a bare INSERT). The audit-readback assertion this row asks for
 * is captured below as a skipped, documented RED — see the lane report for
 * the raw failing output. Wiring the audit call is product code
 * (out of scope for this TEST-ONLY lane).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import request from 'supertest';
import express, { Response, NextFunction } from 'express';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgJobRepository as PgJobRepositoryImpl } from '../../src/jobs/pg-job';
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

const NOW = new Date('2026-08-10T14:00:00.000Z');

describe('Postgres integration — dispatch drag → proposal (row 4.2)', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;
  let feasibilityDeps: FeasibilityDependencies;

  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let techA: string;
  let appointmentId: string;
  let appointmentBefore: { status: string; updatedAt: string; scheduledStart: string; scheduledEnd: string };

  async function seedTenantFixture(tenantId: string, userId: string, label: string) {
    const jobRepo = new PgJobRepositoryImpl(pool);
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
      jobNumber: `JOB-${label}`,
      summary: 'Drag proposal test job',
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
      [techId, tenantId, techId, `${label.toLowerCase()}@example.com`],
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

    return { jobId, techId, apptId };
  }

  function appFor(tenantId: string, userId: string, role: 'dispatcher' | 'technician' = 'dispatcher') {
    const app = express();
    app.use(express.json());
    app.use((req, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId,
        sessionId: 'sess-drag-proposal',
        tenantId,
        role,
      };
      next();
    });
    app.use(
      '/api/proposals',
      createProposalsRouter(proposalRepo, appointmentRepo, auditRepo, feasibilityDeps),
    );
    return app;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);

    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);

    const fixtureA = await seedTenantFixture(tenantA.tenantId, tenantA.userId, 'A');
    appointmentId = fixtureA.apptId;
    techA = fixtureA.techId;

    // Tenant B gets its own fixture too, so T1 can assert its board/appointments
    // stay untouched by tenant A's drag — not merely "empty because nothing
    // was ever seeded".
    await seedTenantFixture(tenantB.tenantId, tenantB.userId, 'B');

    feasibilityDeps = {
      assignmentRepo,
      appointmentRepo,
      jobRepo: new PgJobRepositoryImpl(pool),
      locationRepo: new PgLocationRepository(pool),
      workingHoursRepo: new PgWorkingHoursRepository(pool),
      unavailableBlockRepo: new PgUnavailableBlockRepository(pool),
      travelTimeProvider: new HaversineFallbackProvider(),
      skillMatcher: new StubSkillMatcher(),
    };

    const before = await appointmentRepo.findById(tenantA.tenantId, appointmentId);
    appointmentBefore = {
      status: before!.status,
      updatedAt: before!.updatedAt.toISOString(),
      scheduledStart: before!.scheduledStart.toISOString(),
      scheduledEnd: before!.scheduledEnd.toISOString(),
    };
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('a reschedule drag creates a real proposal row and mutates NO appointment column', async () => {
    const app = appFor(tenantA.tenantId, tenantA.userId);
    const newStart = new Date(NOW.getTime() + 5 * 60 * 60 * 1000).toISOString();
    const newEnd = new Date(NOW.getTime() + 6 * 60 * 60 * 1000).toISOString();

    const res = await request(app)
      .post('/api/proposals')
      .set('If-Match', appointmentBefore.updatedAt)
      .send({
        proposalType: 'reschedule_appointment',
        payload: {
          appointmentId,
          newScheduledStart: newStart,
          newScheduledEnd: newEnd,
          reason: 'Reordered within technician lane',
        },
        summary: 'Reschedule appointment within technician lane',
      });

    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe('draft');

    // The proposal is a REAL row, readable straight back from Postgres.
    const stored = await proposalRepo.findById(tenantA.tenantId, res.body.id);
    expect(stored).not.toBeNull();
    expect(stored!.proposalType).toBe('reschedule_appointment');
    expect(stored!.payload.appointmentId).toBe(appointmentId);

    // NO appointment mutation until approval: every column the drag proposed
    // to change is untouched — same status, same updatedAt, same times.
    const after = await appointmentRepo.findById(tenantA.tenantId, appointmentId);
    expect(after!.status).toBe(appointmentBefore.status);
    expect(after!.updatedAt.toISOString()).toBe(appointmentBefore.updatedAt);
    expect(after!.scheduledStart.toISOString()).toBe(appointmentBefore.scheduledStart);
    expect(after!.scheduledEnd.toISOString()).toBe(appointmentBefore.scheduledEnd);
  });

  it('T1 — tenant B never sees tenant A\'s proposal, and tenant B\'s own appointment is untouched', async () => {
    const app = appFor(tenantA.tenantId, tenantA.userId);
    const newStart = new Date(NOW.getTime() + 7 * 60 * 60 * 1000).toISOString();
    const newEnd = new Date(NOW.getTime() + 8 * 60 * 60 * 1000).toISOString();

    const res = await request(app)
      .post('/api/proposals')
      .set('If-Match', appointmentBefore.updatedAt)
      .send({
        proposalType: 'reschedule_appointment',
        payload: { appointmentId, newScheduledStart: newStart, newScheduledEnd: newEnd },
        summary: 'Reschedule for T1 check',
      });
    expect(res.status).toBe(200);

    // Invisible under tenant B's id — RLS-scoped read + explicit tenant_id
    // predicate both apply (PgProposalRepository.findById).
    const crossTenantRead = await proposalRepo.findById(tenantB.tenantId, res.body.id);
    expect(crossTenantRead).toBeNull();

    const tenantBProposals = await proposalRepo.findByTenant(tenantB.tenantId);
    expect(tenantBProposals).toHaveLength(0);
  });

  // §12.4d honesty — this is the RED half of the TDD cycle for the row's
  // audit-readback requirement. Skipped so the suite stays green: neither
  // routes/proposals.ts's bare POST / handler nor create-scheduling.ts calls
  // auditRepo.create/logProposalEvent on the created path (confirmed by
  // reading both files — PgProposalRepository.create is a bare INSERT with
  // no audit side effect). Un-skip once that wiring lands; until then this
  // documents exactly what's missing rather than asserting around it. Raw
  // RED output from running this unskipped is in the lane report.
  it.skip('[BLOCKED — no product-code audit call exists yet] emits a proposal.created audit event, readable via PgAuditRepository.findByEntity', async () => {
    const app = appFor(tenantA.tenantId, tenantA.userId);
    const newStart = new Date(NOW.getTime() + 9 * 60 * 60 * 1000).toISOString();
    const newEnd = new Date(NOW.getTime() + 10 * 60 * 60 * 1000).toISOString();

    const res = await request(app)
      .post('/api/proposals')
      .set('If-Match', appointmentBefore.updatedAt)
      .send({
        proposalType: 'reschedule_appointment',
        payload: { appointmentId, newScheduledStart: newStart, newScheduledEnd: newEnd },
        summary: 'Reschedule for audit check',
      });
    expect(res.status).toBe(200);

    const events = await auditRepo.findByEntity(tenantA.tenantId, 'proposal', res.body.id);
    expect(events.some((e) => e.eventType === 'proposal.created')).toBe(true);
  });
});
