/**
 * U2 (B7.10) — crew add/remove by voice, end-to-end against real Postgres.
 *
 * "Add Jake to the 2pm tomorrow" used to dead-end: the crew task handlers
 * gated appointmentId UNCONDITIONALLY and add_crew_member/remove_crew_member
 * were absent from APPOINTMENT_REF_INTENTS, so the entity resolver was never
 * even asked. This file proves the closed loop with the REAL resolver
 * (PgEntityResolver — pg_trgm + tenant-zone clock-time resolution) and the
 * PRODUCTION execution registry, asserting EXECUTED EFFECTS (P-44):
 *
 *   1. Unique appointment (by time, tenant zone) + unique technician name →
 *      resolver threads both ids → ungated draft → approve → execute writes
 *      the non-primary appointment_assignments row + audit event; the remove
 *      leg then deletes it + its audit event.
 *   2. P-43 picker bounds against the REAL resolver: two same-window
 *      appointments → a BOUNDED ambiguity (≤5 candidates, one-tap picker);
 *      MORE than the 5-candidate picker limit → not_found → the draft gates
 *      honestly (never an overflowing/arbitrary picker).
 *   3. Cross-tenant negative: a forged add_crew_member under another tenant
 *      fails closed and writes nothing.
 *
 * Harness mirrors test/integration/reschedule-appointment-voice.test.ts
 * (task handler → transitionProposal → ProposalExecutor with the production
 * registry) and test/integration/entity-resolution.test.ts (realistic seeds:
 * the technician's name lives ONLY on the users row, the appointment is
 * found by TIME in the tenant's zone).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { DateTime } from 'luxon';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { resolveVoiceEntityReferences } from '../../src/ai/agents/customer-calling/entity-resolution';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import {
  AddCrewMemberTaskHandler,
  RemoveCrewMemberTaskHandler,
} from '../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../src/ai/tasks/task-handlers';
import {
  createProposal,
  missingFieldsFor,
  InMemoryProposalRepository,
  Proposal,
} from '../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  ExecutionContext,
  ExecutionResult,
  createExecutionHandlerRegistry,
} from '../../src/proposals/execution/handlers';

const TZ = 'America/Chicago';
const REFERENCE = 'tomorrow at 2';

describe('Integration — U2 crew add/remove by voice (real Postgres + real resolver)', () => {
  let pool: Pool;
  let resolver: PgEntityResolver;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    resolver = new PgEntityResolver(pool);
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

  /** Tomorrow `hour`:00 wall-clock in the tenant zone, as a UTC instant. */
  function tomorrowLocalHourUtc(hour: number): Date {
    return DateTime.now()
      .setZone(TZ)
      .plus({ days: 1 })
      .set({ hour, minute: 0, second: 0, millisecond: 0 })
      .toUTC()
      .toJSDate();
  }

  interface Seed {
    tenantId: string;
    userId: string;
    jobId: string;
  }

  /** Tenant (with a timezone) + customer + location + one ordinary job. */
  async function seedTenantWithJob(): Promise<Seed> {
    const t = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region)
       VALUES ($1, $2, 'Crew Test Shop', $3, 'TX')`,
      [crypto.randomUUID(), t.tenantId, TZ],
    );

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Dana',
      lastName: 'Miller',
      displayName: 'Dana Miller',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: '12 Crew Ct',
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
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-CREW-${jobId.slice(0, 8)}`,
      summary: 'AC repair',
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { tenantId: t.tenantId, userId: t.userId, jobId };
  }

  async function seedAppointmentAt(seed: Seed, start: Date): Promise<string> {
    const appointmentId = crypto.randomUUID();
    await appointmentRepo.create({
      id: appointmentId,
      tenantId: seed.tenantId,
      jobId: seed.jobId,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 2 * 60 * 60 * 1000),
      timezone: TZ,
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: seed.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return appointmentId;
  }

  /** The technician's name lives ONLY on the users row (realistic seed). */
  async function seedTechnician(tenantId: string, firstName: string, lastName: string): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name)
       VALUES ($1, $2, $3, $4, 'technician', $5, $6)`,
      [
        id,
        tenantId,
        `clerk-${id}`,
        `${firstName}.${lastName}.${id.slice(0, 8)}@example.com`.toLowerCase(),
        firstName,
        lastName,
      ],
    );
    return id;
  }

  /**
   * The router's exact pre-draft step: intent-conditioned resolution over the
   * classifier's free-text references (annotateResolvedEntities calls this
   * same function with this same shape).
   */
  async function resolveCrewReferences(tenantId: string, intent: string) {
    return resolveVoiceEntityReferences(resolver, {
      tenantId,
      intent,
      entities: { appointmentReference: REFERENCE, targetTechnicianName: 'Jake' },
    });
  }

  function crewContext(
    seed: Seed,
    message: string,
    resolved: Record<string, string | undefined>,
  ): TaskContext {
    return {
      tenantId: seed.tenantId,
      userId: seed.userId,
      message,
      existingEntities: {
        appointmentReference: REFERENCE,
        targetTechnicianName: 'Jake',
        ...(resolved.appointmentId ? { appointmentId: resolved.appointmentId } : {}),
        ...(resolved.technicianId ? { technicianId: resolved.technicianId } : {}),
      },
    };
  }

  async function approveAndExecute(
    draft: Proposal,
    userId: string,
  ): Promise<ExecutionResult> {
    let proposal = transitionProposal(draft, 'ready_for_review', userId);
    proposal = transitionProposal(proposal, 'approved', userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };

    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    // PRODUCTION registry — same construction app.ts uses.
    const handlers = createExecutionHandlerRegistry({ appointmentRepo, assignmentRepo, auditRepo });
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(handlers, proposalRepo, guard, auditRepo);
    await proposalRepo.create(proposal);

    const context: ExecutionContext = { tenantId: proposal.tenantId, executedBy: userId };
    const { result } = await executor.execute(proposal, context);
    return result;
  }

  it('"add Jake to the 2pm tomorrow" resolves both references, drafts ungated, and EXECUTES: assignment row + audit; the remove leg then deletes it', async () => {
    const seed = await seedTenantWithJob();
    const appointmentId = await seedAppointmentAt(seed, tomorrowLocalHourUtc(14));
    const jakeId = await seedTechnician(seed.tenantId, 'Jake', 'Ruiz');

    // The REAL resolver answers both references (U2 routed the appointment
    // lookup for crew intents; U1 already routed the technician lookup).
    const annotation = await resolveCrewReferences(seed.tenantId, 'add_crew_member');
    expect(annotation.kind).toBe('ok');
    if (annotation.kind !== 'ok') return;
    expect(annotation.resolved.appointmentId).toBe(appointmentId);
    expect(annotation.resolved.technicianId).toBe(jakeId);

    // Draft exactly the way the router does: resolved ids ride the context.
    const { proposal: draft } = await new AddCrewMemberTaskHandler().handle(
      crewContext(seed, 'Add Jake to the 2pm tomorrow', annotation.resolved),
    );
    expect(missingFieldsFor(draft)).toEqual([]);
    expect(draft.payload.appointmentId).toBe(appointmentId);
    expect(draft.payload.technicianId).toBe(jakeId);
    expect(draft.status).toBe('draft'); // capture-class, still a human tap

    const addResult = await approveAndExecute(draft, seed.userId);
    expect(addResult.success).toBe(true);

    // Executed effect — the REAL appointment_assignments row, non-primary.
    const { rows: assignRows } = await pool.query(
      `SELECT technician_id, is_primary FROM appointment_assignments
        WHERE tenant_id = $1 AND appointment_id = $2`,
      [seed.tenantId, appointmentId],
    );
    expect(assignRows).toHaveLength(1);
    expect(assignRows[0].technician_id).toBe(jakeId);
    expect(assignRows[0].is_primary).toBe(false);

    const addAudit = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE tenant_id = $1 AND entity_type = 'appointment' AND entity_id = $2
          AND event_type = 'appointment.technician_assigned'`,
      [seed.tenantId, appointmentId],
    );
    expect(addAudit.rows).toHaveLength(1);

    // ── Remove leg: same resolution, opposite mutation. ──────────────────
    const removeAnnotation = await resolveCrewReferences(seed.tenantId, 'remove_crew_member');
    expect(removeAnnotation.kind).toBe('ok');
    if (removeAnnotation.kind !== 'ok') return;
    expect(removeAnnotation.resolved.appointmentId).toBe(appointmentId);

    const { proposal: removeDraft } = await new RemoveCrewMemberTaskHandler().handle(
      crewContext(seed, 'Take Jake off the 2pm tomorrow', removeAnnotation.resolved),
    );
    expect(missingFieldsFor(removeDraft)).toEqual([]);

    const removeResult = await approveAndExecute(removeDraft, seed.userId);
    expect(removeResult.success).toBe(true);

    const { rows: afterRows } = await pool.query(
      `SELECT id FROM appointment_assignments WHERE tenant_id = $1 AND appointment_id = $2`,
      [seed.tenantId, appointmentId],
    );
    expect(afterRows).toHaveLength(0);

    const removeAudit = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE tenant_id = $1 AND entity_type = 'appointment' AND entity_id = $2
          AND event_type = 'appointment.technician_unassigned'`,
      [seed.tenantId, appointmentId],
    );
    expect(removeAudit.rows).toHaveLength(1);
  });

  it('P-43 picker bounds: two same-window appointments → BOUNDED ambiguity; more than the picker limit → not_found → honest gate', async () => {
    // Two at the stated time: a one-tap picker, never a guess — and the
    // candidate list is bounded by the resolver's own cap.
    const two = await seedTenantWithJob();
    await seedAppointmentAt(two, tomorrowLocalHourUtc(14));
    await seedAppointmentAt(two, tomorrowLocalHourUtc(14));
    await seedTechnician(two.tenantId, 'Jake', 'Ruiz');

    const ambiguous = await resolveCrewReferences(two.tenantId, 'add_crew_member');
    expect(ambiguous.kind).toBe('ambiguous');
    if (ambiguous.kind === 'ambiguous') {
      expect(ambiguous.entityKind).toBe('appointment');
      expect(ambiguous.candidates.length).toBe(2);
      expect(ambiguous.candidates.length).toBeLessThanOrEqual(5);
    }

    // SIX at the stated time — beyond what a picker can honestly show. The
    // resolver refuses (not_found) instead of reading back an arbitrary
    // five, and the draft gates instead of overflowing the clarification.
    const six = await seedTenantWithJob();
    for (let i = 0; i < 6; i++) {
      await seedAppointmentAt(six, tomorrowLocalHourUtc(14));
    }
    const jakeId = await seedTechnician(six.tenantId, 'Jake', 'Ruiz');

    const overflow = await resolveCrewReferences(six.tenantId, 'add_crew_member');
    expect(overflow.kind).toBe('ok');
    if (overflow.kind !== 'ok') return;
    expect(overflow.resolved.appointmentId).toBeUndefined();
    expect(overflow.resolved.technicianId).toBe(jakeId);
    expect(overflow.pendingReferences).toEqual([
      { kind: 'appointment', reference: REFERENCE },
    ]);

    const { proposal: gated } = await new AddCrewMemberTaskHandler().handle(
      crewContext(six, 'Add Jake to the 2pm tomorrow', overflow.resolved),
    );
    expect(missingFieldsFor(gated)).toEqual(['appointmentId']);
    expect(gated.payload.appointmentId).toBeUndefined();
  });

  it('cross-tenant negative: a forged add_crew_member under another tenant fails closed and writes nothing', async () => {
    const tenantA = await seedTenantWithJob();
    const appointmentId = await seedAppointmentAt(tenantA, tomorrowLocalHourUtc(14));
    const jakeId = await seedTechnician(tenantA.tenantId, 'Jake', 'Ruiz');
    const tenantB = await createTestTenant(pool);

    const handlers = createExecutionHandlerRegistry({ appointmentRepo, assignmentRepo, auditRepo });
    const forged = createProposal({
      tenantId: tenantB.tenantId,
      proposalType: 'add_crew_member',
      payload: { appointmentId, technicianId: jakeId },
      summary: 'cross-tenant crew attempt',
      createdBy: tenantB.userId,
    });
    const result = await handlers.get('add_crew_member')!.execute(forged, {
      tenantId: tenantB.tenantId,
      executedBy: tenantB.userId,
    });
    expect(result.success).toBe(false);

    const { rows } = await pool.query(
      `SELECT id FROM appointment_assignments WHERE appointment_id = $1`,
      [appointmentId],
    );
    expect(rows).toHaveLength(0);

    const crossAudit = await pool.query(
      `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_id = $2`,
      [tenantB.tenantId, appointmentId],
    );
    expect(crossAudit.rows).toHaveLength(0);
  });
});
