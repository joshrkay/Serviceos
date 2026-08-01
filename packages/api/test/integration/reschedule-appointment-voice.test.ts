/**
 * B4.7 restoration — voice `reschedule_appointment` end-to-end against real
 * Postgres.
 *
 * Closes the gap flagged in the Part E post-review round (run log #17): the
 * spoken reschedule chain (classify → draft → approve → execute) was scored
 * rung 3 because no integration test drove a task-produced payload through
 * the REAL `RescheduleAppointmentTaskHandler` and the PRODUCTION
 * `RescheduleAppointmentExecutionHandler` (obtained via
 * `createExecutionHandlerRegistry`, not constructed directly) against genuine
 * Postgres columns.
 *
 * Mirrors test/integration/voice-inbound-appointment.test.ts and
 * test/integration/draft-estimate-execution.test.ts's conventions.
 *
 * Proves, for "Move the Garcia job to Thursday at 10":
 *   1. The REAL task handler resolves the caller's single active appointment
 *      and the spoken phrase deterministically (tenant timezone + a fixed
 *      `now`, via `resolveDateTime` — no LLM round-trip, no hardcoded zone)
 *      into a draft `reschedule_appointment` proposal with no missing fields.
 *   2. approve → execute via the registered `RescheduleAppointmentExecutionHandler`
 *      updates the appointment's scheduled window to the resolved instant AND
 *      emits exactly one `appointment.rescheduled` audit event, with the
 *      executing actor as `actorId`.
 *   3. Cross-tenant negative: another tenant can neither read the appointment
 *      through the scoped repo, nor affect it even when the registered
 *      handler is invoked directly with that tenant's id in the execution
 *      context (RLS-backed — repo queries run under `rls_app_runtime` when
 *      RLS_RUNTIME_ROLE=true).
 *
 * Each `it` seeds its own TENANT (not just its own customer/job/appointment):
 * `resolveActiveAppointmentId`'s tenant-wide fallback (see the NOTE below)
 * requires the tenant to have exactly one active appointment to resolve
 * unambiguously, so sharing one tenant across tests would make the second
 * seeded appointment collide with the first and turn "resolve the Garcia
 * appointment" ambiguous. Isolated tenants keep each test's fixture at
 * exactly one active appointment and avoid double-counting audit events
 * across "approve → execute" runs (a real DB mutation).
 *
 * FOUND-BY-PROOF (reported, not fixed — see run report): the entity-resolver
 * seam at voice-action-router.ts:1490-1508 threads a resolved `appointmentId`
 * onto `TaskContext.existingEntities` when the entity resolver disambiguates
 * a spoken reference ("the Garcia job") against tenant records — the same
 * seam ReassignAppointmentTaskHandler reads for `technicianId`.
 * `RescheduleAppointmentTaskHandler.handle` (and `CancelAppointmentTaskHandler
 * .handle`) never read `existingEntities.appointmentId`; they independently
 * re-resolve via `resolveActiveAppointmentId`, which (absent a verified
 * caller identity — true for an owner/dispatcher command like this one, only
 * ever populated for an inbound customer call) falls back to "does this
 * TENANT have exactly one active appointment", with no name/reference
 * disambiguation. Empirically confirmed while writing this test: an earlier
 * draft shared one tenant fixture across all three `it` blocks (mirroring
 * draft-estimate-execution.test.ts's one-tenant-many-creates style) and the
 * SECOND `it`'s execution failed with "Payload must include a valid
 * appointmentId" — once the tenant had two active appointments (one seeded
 * per test), the fallback could no longer resolve either one, even though
 * `existingEntities.appointmentId` in the context carried the correct id the
 * whole time. "Move the Garcia job to Thursday at 10" cannot resolve in any
 * tenant with more than one active appointment. Each `it` below now uses an
 * isolated tenant (exactly one active appointment) so the happy path this AC
 * asks for is provable; that isolation is itself evidence of the gap, not a
 * workaround for a test-only issue.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { RescheduleAppointmentTaskHandler } from '../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../src/ai/tasks/task-handlers';
import { resolveDateTime } from '../../src/ai/scheduling/resolve-datetime';
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

// Monday 2026-08-03 noon in America/Chicago (fixed, deterministic anchor for
// resolveDateTime's forwardDate weekday resolution).
const NOW = new Date('2026-08-03T17:00:00.000Z');
const TENANT_TIMEZONE = 'America/Chicago';
const PHRASE = 'Thursday at 10';
// The original appointment is 2 hours long; the handler must preserve that
// duration on reschedule instead of collapsing to the 60-min default.
const ORIGINAL_DURATION_MIN = 120;
const EXPECTED_START_UTC = '2026-08-06T15:00:00.000Z';
const EXPECTED_END_UTC = '2026-08-06T17:00:00.000Z';

describe('Integration — voice reschedule_appointment (real Postgres)', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    auditRepo = new PgAuditRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /**
   * Seed a fresh customer/location/job/appointment under `tenantId` — the
   * tenant's ONLY active appointment (what `resolveActiveAppointmentId`'s
   * tenant-wide fallback needs to resolve unambiguously). Monday 9-11am,
   * strictly before the fixed `now`'s Thursday target, so a reschedule
   * genuinely moves it forward.
   */
  async function seedGarciaAppointment(
    tenantId: string,
    userId: string,
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
      scheduledStart: new Date('2026-08-03T14:00:00.000Z'),
      scheduledEnd: new Date('2026-08-03T16:00:00.000Z'),
      timezone: TENANT_TIMEZONE,
      status: 'scheduled',
      holdPendingApproval: false,
      notes: 'Garcia job',
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { appointmentId };
  }

  function buildContext(tenantId: string, userId: string, appointmentId: string): TaskContext {
    return {
      tenantId,
      userId,
      message: 'Move the Garcia job to Thursday at 10',
      existingEntities: {
        appointmentReference: 'the Garcia job',
        newDateTimeDescription: PHRASE,
        // Resolver-style seam (voice-action-router.ts:1490-1508) — see the
        // top-of-file NOTE: not read by the handler today.
        appointmentId,
      },
      timezone: TENANT_TIMEZONE,
      now: NOW,
    };
  }

  it('drafts a reschedule_appointment proposal with the deterministically resolved window', async () => {
    const tenant = await createTestTenant(pool);
    const { appointmentId } = await seedGarciaAppointment(tenant.tenantId, tenant.userId);
    const handler = new RescheduleAppointmentTaskHandler(undefined, appointmentRepo, jobRepo);
    const result = await handler.handle(buildContext(tenant.tenantId, tenant.userId, appointmentId));

    expect(result.taskType).toBe('reschedule_appointment');
    expect(result.proposal.proposalType).toBe('reschedule_appointment');
    expect(result.proposal.status).toBe('draft');

    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.appointmentId).toBe(appointmentId);
    expect(payload.missingFields).toBeUndefined();

    const expected = resolveDateTime(PHRASE, {
      timezone: TENANT_TIMEZONE,
      now: NOW,
      defaultDurationMin: ORIGINAL_DURATION_MIN,
    });
    expect(expected.ok).toBe(true);
    if (!expected.ok) throw new Error('unreachable');
    expect(payload.newScheduledStart).toBe(expected.startUtc);
    expect(payload.newScheduledEnd).toBe(expected.endUtc);
    // Sanity: the resolved window really is Thursday 10am-noon Chicago,
    // i.e. genuinely later than the seeded Monday appointment.
    expect(payload.newScheduledStart).toBe(EXPECTED_START_UTC);
    expect(payload.newScheduledEnd).toBe(EXPECTED_END_UTC);
  });

  async function draftApproveExecute(
    tenantId: string,
    userId: string,
    appointmentId: string,
  ): Promise<{ proposal: Proposal; resultEntityId: string }> {
    const handler = new RescheduleAppointmentTaskHandler(undefined, appointmentRepo, jobRepo);
    const draft = await handler.handle(buildContext(tenantId, userId, appointmentId));

    let proposal: Proposal = draft.proposal;
    expect((proposal.payload as Record<string, unknown>).missingFields).toBeUndefined();
    proposal = transitionProposal(proposal, 'ready_for_review', userId);
    proposal = transitionProposal(proposal, 'approved', userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };

    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    // PRODUCTION registry — proves the registry wires auditRepo into
    // RescheduleAppointmentExecutionHandler exactly as app.ts does.
    const handlers = createExecutionHandlerRegistry({ appointmentRepo, auditRepo });
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(handlers, proposalRepo, guard, auditRepo);
    await proposalRepo.create(proposal);

    const context: ExecutionContext = { tenantId, executedBy: userId };
    const { result } = await executor.execute(proposal, context);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(appointmentId);

    return { proposal, resultEntityId: result.resultEntityId as string };
  }

  it('approve → execute updates the scheduled window and emits exactly one appointment.rescheduled audit event', async () => {
    const tenant = await createTestTenant(pool);
    const { appointmentId } = await seedGarciaAppointment(tenant.tenantId, tenant.userId);
    await draftApproveExecute(tenant.tenantId, tenant.userId, appointmentId);

    const updated = await appointmentRepo.findById(tenant.tenantId, appointmentId);
    expect(updated).not.toBeNull();
    expect(updated!.scheduledStart.toISOString()).toBe(EXPECTED_START_UTC);
    expect(updated!.scheduledEnd.toISOString()).toBe(EXPECTED_END_UTC);
    // Reschedule mutates times only — status is untouched.
    expect(updated!.status).toBe('scheduled');

    const { rows } = await pool.query(
      `SELECT event_type, actor_id, entity_type, entity_id, metadata
         FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'appointment.rescheduled'
          AND entity_type = 'appointment' AND entity_id = $2`,
      [tenant.tenantId, appointmentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(tenant.userId);
    expect(rows[0].metadata.newScheduledStart).toBe(EXPECTED_START_UTC);
    expect(rows[0].metadata.newScheduledEnd).toBe(EXPECTED_END_UTC);
  });

  it('cross-tenant negative: another tenant cannot read or affect the rescheduled appointment', async () => {
    const tenant = await createTestTenant(pool);
    const { appointmentId } = await seedGarciaAppointment(tenant.tenantId, tenant.userId);
    await draftApproveExecute(tenant.tenantId, tenant.userId, appointmentId);
    const other = await createTestTenant(pool);

    // Read side — the scoped repo call under the OTHER tenant's id (and,
    // under RLS_RUNTIME_ROLE=true, the rls_app_runtime role) returns nothing.
    const found = await appointmentRepo.findById(other.tenantId, appointmentId);
    expect(found).toBeNull();

    // Affect side — even calling the registered execution handler directly
    // with the other tenant stamped into the ExecutionContext cannot move
    // tenant A's appointment: the handler's own tenant-scoped lookup can't
    // see the row (same RLS boundary), so it fails closed instead of
    // rescheduling a stranger's appointment.
    const handlers = createExecutionHandlerRegistry({ appointmentRepo, auditRepo });
    const rescheduleHandler = handlers.get('reschedule_appointment')!;
    const forgedProposal = createProposal({
      tenantId: other.tenantId,
      proposalType: 'reschedule_appointment',
      payload: {
        appointmentId,
        newScheduledStart: '2026-08-07T15:00:00.000Z',
        newScheduledEnd: '2026-08-07T17:00:00.000Z',
      },
      summary: 'cross-tenant reschedule attempt',
      createdBy: other.userId,
    });
    const forgedResult = await rescheduleHandler.execute(forgedProposal, {
      tenantId: other.tenantId,
      executedBy: other.userId,
    });
    expect(forgedResult.success).toBe(false);

    // The real appointment is unchanged from the tenant-A reschedule above.
    const stillA = await appointmentRepo.findById(tenant.tenantId, appointmentId);
    expect(stillA!.scheduledStart.toISOString()).toBe(EXPECTED_START_UTC);

    const crossAudit = await pool.query(
      `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_id = $2`,
      [other.tenantId, appointmentId],
    );
    expect(crossAudit.rows).toHaveLength(0);
  });
});
