/**
 * B5.3 — voice `reassign_appointment` end-to-end against real Postgres.
 *
 * AC-2/AC-5: the task-produced payload (real `ReassignAppointmentTaskHandler`,
 * post-fix) → approve → execute via the PRODUCTION
 * `ReassignAppointmentExecutionHandler` (obtained via
 * `createExecutionHandlerRegistry`, not constructed directly) → the
 * appointment's technician actually changes in real Postgres, the staleness
 * AND feasibility gates genuinely run (not just present-but-inert — each is
 * separately proven to observe live DB state), a reassignment audit event is
 * recorded, and a cross-tenant negative holds.
 *
 * Mirrors test/integration/reschedule-appointment-voice.test.ts's
 * conventions (read per the task brief before writing this file).
 *
 * FOUND-BY-PROOF, reported not fixed (out of B5.3's declared 3-defect scope
 * per b5.3-design.md): `checkSchedulingProposalFreshness` only compares
 * against `proposal.sourceContext.{status,scheduledStart,scheduledEnd,
 * technicianId}`, but NOTHING in the voice draft path (inputFor/
 * baseSourceContext in voice-extended-tasks.ts) ever snapshots those fields
 * onto a reassign_appointment proposal's sourceContext. So for a REAL
 * voice-drafted proposal the staleness check is a structural no-op today —
 * it runs (the code path executes, `assignmentRepo.findByAppointment` is
 * called) but has nothing to compare against and always reports fresh. The
 * "gate ran and blocked" proof below manually stamps a baseline onto
 * sourceContext to demonstrate the mechanism is real and wired end to end;
 * it does not claim the voice task handler populates that baseline today.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { assignTechnician } from '../../src/appointments/assignment';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgWorkingHoursRepository } from '../../src/availability/pg-working-hours';
import { PgUnavailableBlockRepository } from '../../src/availability/pg-unavailable-block';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { ReassignAppointmentTaskHandler } from '../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../src/ai/tasks/task-handlers';
import {
  createProposal,
  InMemoryProposalRepository,
  Proposal,
} from '../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  ExecutionContext,
  createExecutionHandlerRegistry,
} from '../../src/proposals/execution/handlers';

describe('Integration — voice reassign_appointment (real Postgres)', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    auditRepo = new PgAuditRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function feasibilityDeps(tenantAssignmentRepo: PgAssignmentRepository): FeasibilityDependencies {
    return {
      assignmentRepo: tenantAssignmentRepo,
      appointmentRepo,
      jobRepo,
      locationRepo,
      workingHoursRepo: new PgWorkingHoursRepository(pool),
      unavailableBlockRepo: new PgUnavailableBlockRepository(pool),
      travelTimeProvider: new HaversineFallbackProvider(),
      skillMatcher: new StubSkillMatcher(),
    };
  }

  async function seedTechnician(tenantId: string, firstName: string, lastName: string): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name)
       VALUES ($1, $2, $3, $4, 'technician', $5, $6)`,
      [id, tenantId, `clerk-${id}`, `${firstName}.${lastName}.${id.slice(0, 8)}@example.com`.toLowerCase(), firstName, lastName],
    );
    return id;
  }

  /**
   * Seed a fresh customer/location/job/appointment under `tenantId` with an
   * initial PRIMARY technician assignment — mirrors
   * reschedule-appointment-voice.test.ts's seedGarciaAppointment, plus the
   * assignment reassign_appointment needs to have something to change FROM.
   */
  async function seedGarciaAppointment(
    tenantId: string,
    userId: string,
    initialTechnicianId: string,
    opts: { start?: Date; end?: Date } = {},
  ): Promise<{ appointmentId: string }> {
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: 'Garcia',
      lastName: 'Customer',
      displayName: 'Garcia',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId,
      customerId,
      street1: '9 Garcia Way',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-GARCIA-${jobId.slice(0, 8)}`,
      summary: 'Garcia job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const appointmentId = crypto.randomUUID();
    await appointmentRepo.create({
      id: appointmentId,
      tenantId,
      jobId,
      scheduledStart: opts.start ?? new Date('2026-08-03T14:00:00.000Z'),
      scheduledEnd: opts.end ?? new Date('2026-08-03T16:00:00.000Z'),
      timezone: 'America/Chicago',
      status: 'scheduled',
      holdPendingApproval: false,
      notes: 'Garcia job',
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await assignTechnician(
      {
        tenantId,
        appointmentId,
        technicianId: initialTechnicianId,
        technicianRole: 'technician',
        isPrimary: true,
        assignedBy: userId,
      },
      assignmentRepo,
    );

    return { appointmentId };
  }

  function buildContext(
    tenantId: string,
    userId: string,
    appointmentId: string,
    technicianId: string,
  ): TaskContext {
    return {
      tenantId,
      userId,
      message: 'Assign Felix to the Garcia job',
      existingEntities: {
        appointmentReference: 'the Garcia job',
        // Router-resolved seam (voice-action-router.ts:1589-1591) — the
        // AC-2 fix: ReassignAppointmentTaskHandler now reads this via
        // resolvedAppointmentIdFrom instead of always gating it.
        appointmentId,
        targetTechnicianName: 'Felix Diaz',
        // Router-resolved seam (voice-action-router.ts:1593-1595, U1).
        technicianId,
      },
      now: new Date('2026-08-03T10:00:00.000Z'),
    };
  }

  it('AC-2: drafts a reassign_appointment proposal with resolver-provided ids and no missing fields', async () => {
    const tenant = await createTestTenant(pool);
    const techA = await seedTechnician(tenant.tenantId, 'Aiden', 'Cole');
    const techB = await seedTechnician(tenant.tenantId, 'Felix', 'Diaz');
    const { appointmentId } = await seedGarciaAppointment(tenant.tenantId, tenant.userId, techA);

    const handler = new ReassignAppointmentTaskHandler();
    const result = await handler.handle(
      buildContext(tenant.tenantId, tenant.userId, appointmentId, techB),
    );

    expect(result.taskType).toBe('reassign_appointment');
    expect(result.proposal.proposalType).toBe('reassign_appointment');
    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.appointmentId).toBe(appointmentId);
    expect(payload.toTechnicianId).toBe(techB);
    expect(payload.missingFields).toBeUndefined();
  });

  async function draftApproveExecute(
    tenantId: string,
    userId: string,
    appointmentId: string,
    toTechnicianId: string,
    opts: {
      localAssignmentRepo?: PgAssignmentRepository;
      withFeasibility?: boolean;
      staleSourceContext?: Record<string, unknown>;
    } = {},
  ): Promise<{ proposal: Proposal; result: { success: boolean; error?: string; resultEntityId?: string } }> {
    const localAssignmentRepo = opts.localAssignmentRepo ?? assignmentRepo;
    const handler = new ReassignAppointmentTaskHandler();
    const draft = await handler.handle(
      buildContext(tenantId, userId, appointmentId, toTechnicianId),
    );

    let proposal: Proposal = draft.proposal;
    expect((proposal.payload as Record<string, unknown>).missingFields).toBeUndefined();
    if (opts.staleSourceContext) {
      proposal = { ...proposal, sourceContext: { ...(proposal.sourceContext ?? {}), ...opts.staleSourceContext } };
    }
    proposal = transitionProposal(proposal, 'ready_for_review', userId);
    proposal = transitionProposal(proposal, 'approved', userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };

    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    // PRODUCTION registry — proves the registry wires auditRepo + (when
    // provided) feasibilityDeps into ReassignAppointmentExecutionHandler
    // exactly as app.ts does.
    const handlers = createExecutionHandlerRegistry({
      appointmentRepo,
      assignmentRepo: localAssignmentRepo,
      auditRepo,
      ...(opts.withFeasibility ? { feasibilityDeps: feasibilityDeps(localAssignmentRepo) } : {}),
    });
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(handlers, proposalRepo, guard, auditRepo);
    await proposalRepo.create(proposal);

    const context: ExecutionContext = { tenantId, executedBy: userId };
    const { result } = await executor.execute(proposal, context);

    return { proposal, result };
  }

  it('approve → execute reassigns the technician and emits appointment.technician_assigned audit event', async () => {
    const tenant = await createTestTenant(pool);
    const techA = await seedTechnician(tenant.tenantId, 'Aiden', 'Cole');
    const techB = await seedTechnician(tenant.tenantId, 'Felix', 'Diaz');
    const { appointmentId } = await seedGarciaAppointment(tenant.tenantId, tenant.userId, techA);

    const { result } = await draftApproveExecute(
      tenant.tenantId,
      tenant.userId,
      appointmentId,
      techB,
      { withFeasibility: true },
    );
    expect(result.success).toBe(true);

    const assignments = await assignmentRepo.findByAppointment(tenant.tenantId, appointmentId);
    const primary = assignments.find((a) => a.isPrimary);
    expect(primary?.technicianId).toBe(techB);
    // The old primary was demoted, not deleted — provable, auditable history.
    const oldAssignment = assignments.find((a) => a.technicianId === techA);
    expect(oldAssignment?.isPrimary).toBe(false);

    const { rows } = await pool.query(
      `SELECT event_type, actor_id, entity_type, entity_id, metadata
         FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'appointment.technician_assigned'
          AND entity_type = 'appointment' AND entity_id = $2`,
      [tenant.tenantId, appointmentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(tenant.userId);
    expect(rows[0].metadata.technicianId).toBe(techB);
  });

  it('the feasibility gate actually ran: rejects the reassignment when the target technician has a real conflicting appointment', async () => {
    const tenant = await createTestTenant(pool);
    const techA = await seedTechnician(tenant.tenantId, 'Aiden', 'Cole');
    const techB = await seedTechnician(tenant.tenantId, 'Felix', 'Diaz');
    const { appointmentId } = await seedGarciaAppointment(tenant.tenantId, tenant.userId, techA, {
      start: new Date('2026-09-14T10:00:00.000Z'),
      end: new Date('2026-09-14T11:00:00.000Z'),
    });

    // techB already holds a REAL, overlapping appointment in Postgres — the
    // feasibility gate must see this via the real assignment/appointment
    // repos, not a stub, to block.
    const { appointmentId: conflictingAppointmentId } = await seedGarciaAppointment(
      tenant.tenantId,
      tenant.userId,
      techB,
      { start: new Date('2026-09-14T10:30:00.000Z'), end: new Date('2026-09-14T11:30:00.000Z') },
    );

    const { result } = await draftApproveExecute(
      tenant.tenantId,
      tenant.userId,
      appointmentId,
      techB,
      { withFeasibility: true },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Overlaps with|booked/i);

    // The blocked reassignment left the original technician untouched.
    const assignments = await assignmentRepo.findByAppointment(tenant.tenantId, appointmentId);
    const primary = assignments.find((a) => a.isPrimary);
    expect(primary?.technicianId).toBe(techA);
    void conflictingAppointmentId;
  });

  it('the staleness gate actually ran: rejects execution when the appointment technician changed since drafting', async () => {
    const tenant = await createTestTenant(pool);
    const techA = await seedTechnician(tenant.tenantId, 'Aiden', 'Cole');
    const techB = await seedTechnician(tenant.tenantId, 'Felix', 'Diaz');
    const { appointmentId } = await seedGarciaAppointment(tenant.tenantId, tenant.userId, techA);

    // Simulate the proposal having captured a baseline technician at draft
    // time that no longer matches the appointment's REAL current primary
    // assignment (read live via assignmentRepo.findByAppointment inside the
    // handler) — proving checkSchedulingProposalFreshness genuinely compares
    // against live DB state, not a cached/stubbed value.
    const { result } = await draftApproveExecute(
      tenant.tenantId,
      tenant.userId,
      appointmentId,
      techB,
      { staleSourceContext: { technicianId: 'not-the-real-current-technician' } },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Stale proposal/);

    // Nothing changed — the stale rejection short-circuited before any write.
    const assignments = await assignmentRepo.findByAppointment(tenant.tenantId, appointmentId);
    const primary = assignments.find((a) => a.isPrimary);
    expect(primary?.technicianId).toBe(techA);
  });

  it('cross-tenant negative: another tenant cannot read or affect the reassigned appointment', async () => {
    const tenant = await createTestTenant(pool);
    const techA = await seedTechnician(tenant.tenantId, 'Aiden', 'Cole');
    const techB = await seedTechnician(tenant.tenantId, 'Felix', 'Diaz');
    const { appointmentId } = await seedGarciaAppointment(tenant.tenantId, tenant.userId, techA);
    await draftApproveExecute(tenant.tenantId, tenant.userId, appointmentId, techB, {
      withFeasibility: true,
    });

    const other = await createTestTenant(pool);
    const otherTech = await seedTechnician(other.tenantId, 'Priya', 'Nair');

    // Read side — the scoped repo call under the OTHER tenant's id returns
    // nothing (RLS-backed under RLS_RUNTIME_ROLE=true).
    const found = await appointmentRepo.findById(other.tenantId, appointmentId);
    expect(found).toBeNull();

    // Affect side — even calling the registered execution handler directly
    // with the other tenant stamped into the ExecutionContext cannot touch
    // tenant A's appointment: the handler's own tenant-scoped lookup can't
    // see the row, so it fails closed.
    const handlers = createExecutionHandlerRegistry({ appointmentRepo, assignmentRepo, auditRepo });
    const reassignHandler = handlers.get('reassign_appointment')!;
    const forgedProposal = createProposal({
      tenantId: other.tenantId,
      proposalType: 'reassign_appointment',
      payload: { appointmentId, toTechnicianId: otherTech },
      summary: 'cross-tenant reassign attempt',
      createdBy: other.userId,
    });
    const forgedResult = await reassignHandler.execute(forgedProposal, {
      tenantId: other.tenantId,
      executedBy: other.userId,
    });
    expect(forgedResult.success).toBe(false);

    // The real appointment's technician is unchanged from tenant A's reassign.
    const assignments = await assignmentRepo.findByAppointment(tenant.tenantId, appointmentId);
    const primary = assignments.find((a) => a.isPrimary);
    expect(primary?.technicianId).toBe(techB);

    const crossAudit = await pool.query(
      `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_id = $2`,
      [other.tenantId, appointmentId],
    );
    expect(crossAudit.rows).toHaveLength(0);
  });
});
