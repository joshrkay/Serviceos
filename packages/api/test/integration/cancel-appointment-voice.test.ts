/**
 * B4.7 restoration — voice `cancel_appointment` end-to-end against real
 * Postgres.
 *
 * Closes the gap flagged in the Part E post-review round (run log #17): the
 * spoken cancel chain (classify → draft → approve → execute) was scored
 * rung 3 because no integration test drove a task-produced payload through
 * the REAL `CancelAppointmentTaskHandler` and the PRODUCTION
 * `CancelAppointmentExecutionHandler` (obtained via
 * `createExecutionHandlerRegistry`, not constructed directly) against genuine
 * Postgres columns.
 *
 * Mirrors test/integration/reschedule-appointment-voice.test.ts (sibling of
 * this same restoration item) and test/integration/voice-inbound-appointment
 * .test.ts's conventions.
 *
 * Proves, for "Cancel Tuesday's Garcia appointment":
 *   1. The REAL task handler resolves the caller's single active appointment
 *      into a draft `cancel_appointment` proposal with no missing fields.
 *   2. approve → execute via the registered `CancelAppointmentExecutionHandler`
 *      transitions the appointment to status `canceled` AND emits exactly one
 *      `appointment.canceled` audit event, with the executing actor as
 *      `actorId`.
 *   3. Cross-tenant negative: another tenant can neither read the appointment
 *      through the scoped repo, nor affect it even when the registered
 *      handler is invoked directly with that tenant's id in the execution
 *      context (RLS-backed — repo queries run under `rls_app_runtime` when
 *      RLS_RUNTIME_ROLE=true).
 *   4. The irreversible action class: `actionClassForProposalType
 *      ('cancel_appointment')` is `'irreversible'`, and `decideInitialStatus`
 *      can never return `'approved'` for it — at ANY trust tier, confidence,
 *      supervisor mode/presence, or tenant threshold override. Per CLAUDE.md
 *      "Never auto-execute proposals — all require human approval" and D3
 *      (proposals/proposal.ts:255-482): irreversible actions always land in
 *      'draft' (or, when unsupervised-routing would otherwise surface a
 *      capture-class proposal, still 'draft' — the auto-approve branch in
 *      `decideInitialStatus` is gated on `cls === 'capture'`, so an
 *      irreversible proposal never even reaches the threshold/supervisor
 *      logic that could produce 'approved' or 'ready_for_review').
 *
 * Each `it` seeds its own TENANT for the same reason
 * reschedule-appointment-voice.test.ts does: `resolveActiveAppointmentId`'s
 * tenant-wide fallback (see the FOUND-BY-PROOF note there, which applies
 * identically to `CancelAppointmentTaskHandler`) needs exactly one active
 * appointment in the tenant to resolve unambiguously.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { CancelAppointmentTaskHandler } from '../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../src/ai/tasks/task-handlers';
import {
  actionClassForProposalType,
  decideInitialStatus,
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

const TENANT_TIMEZONE = 'America/Chicago';
// "Tuesday's Garcia appointment" — the seeded appointment's actual scheduled
// day; the handler doesn't need to parse this (cancellation has no
// date-resolution step), it's here for the fixture/message's fidelity to the
// spoken sentence.
const APPOINTMENT_START = new Date('2026-08-04T14:00:00.000Z'); // Tue 9am Chicago
const APPOINTMENT_END = new Date('2026-08-04T16:00:00.000Z');
const CANCEL_REASON = "Customer can't make it Tuesday";

describe('Integration — voice cancel_appointment (real Postgres)', () => {
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
   * tenant-wide fallback needs to resolve unambiguously).
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
      scheduledStart: APPOINTMENT_START,
      scheduledEnd: APPOINTMENT_END,
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
      message: "Cancel Tuesday's Garcia appointment",
      existingEntities: {
        appointmentReference: "Tuesday's Garcia appointment",
        cancellationReason: CANCEL_REASON,
        cancellationType: 'customer_request',
        // Resolver-style seam (voice-action-router.ts:1490-1508) — see
        // reschedule-appointment-voice.test.ts's FOUND-BY-PROOF note: not
        // read by the handler today.
        appointmentId,
      },
      timezone: TENANT_TIMEZONE,
    };
  }

  it('drafts a cancel_appointment proposal with the resolved appointment and reason', async () => {
    const tenant = await createTestTenant(pool);
    const { appointmentId } = await seedGarciaAppointment(tenant.tenantId, tenant.userId);
    const handler = new CancelAppointmentTaskHandler(appointmentRepo, jobRepo);
    const result = await handler.handle(buildContext(tenant.tenantId, tenant.userId, appointmentId));

    expect(result.taskType).toBe('cancel_appointment');
    expect(result.proposal.proposalType).toBe('cancel_appointment');
    // D3: irreversible + no sourceTrustTier on this voice path → always 'draft'.
    expect(result.proposal.status).toBe('draft');

    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.appointmentId).toBe(appointmentId);
    expect(payload.reason).toBe(CANCEL_REASON);
    expect(payload.cancellationType).toBe('customer_request');
    expect(payload.missingFields).toBeUndefined();
  });

  async function draftApproveExecute(
    tenantId: string,
    userId: string,
    appointmentId: string,
  ): Promise<{ proposal: Proposal; resultEntityId: string }> {
    const handler = new CancelAppointmentTaskHandler(appointmentRepo, jobRepo);
    const draft = await handler.handle(buildContext(tenantId, userId, appointmentId));

    let proposal: Proposal = draft.proposal;
    expect((proposal.payload as Record<string, unknown>).missingFields).toBeUndefined();
    proposal = transitionProposal(proposal, 'ready_for_review', userId);
    proposal = transitionProposal(proposal, 'approved', userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };

    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    // PRODUCTION registry — proves the registry wires auditRepo into
    // CancelAppointmentExecutionHandler exactly as app.ts does.
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

  it("approve → execute cancels the appointment and emits exactly one appointment.canceled audit event", async () => {
    const tenant = await createTestTenant(pool);
    const { appointmentId } = await seedGarciaAppointment(tenant.tenantId, tenant.userId);
    await draftApproveExecute(tenant.tenantId, tenant.userId, appointmentId);

    const updated = await appointmentRepo.findById(tenant.tenantId, appointmentId);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('canceled');
    // Cancellation mutates status only — the scheduled window is untouched.
    expect(updated!.scheduledStart.toISOString()).toBe(APPOINTMENT_START.toISOString());
    expect(updated!.scheduledEnd.toISOString()).toBe(APPOINTMENT_END.toISOString());

    const { rows } = await pool.query(
      `SELECT event_type, actor_id, entity_type, entity_id, metadata
         FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'appointment.canceled'
          AND entity_type = 'appointment' AND entity_id = $2`,
      [tenant.tenantId, appointmentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(tenant.userId);
    expect(rows[0].metadata.reason).toBe(CANCEL_REASON);
  });

  it('cross-tenant negative: another tenant cannot read or affect the canceled appointment', async () => {
    const tenant = await createTestTenant(pool);
    const { appointmentId } = await seedGarciaAppointment(tenant.tenantId, tenant.userId);
    await draftApproveExecute(tenant.tenantId, tenant.userId, appointmentId);
    const other = await createTestTenant(pool);

    // Read side — the scoped repo call under the OTHER tenant's id (and,
    // under RLS_RUNTIME_ROLE=true, the rls_app_runtime role) returns nothing.
    const found = await appointmentRepo.findById(other.tenantId, appointmentId);
    expect(found).toBeNull();

    // Affect side — even calling the registered execution handler directly
    // with the other tenant stamped into the ExecutionContext cannot cancel
    // tenant A's appointment: the handler's own tenant-scoped lookup can't
    // see the row (same RLS boundary), so it fails closed.
    const handlers = createExecutionHandlerRegistry({ appointmentRepo, auditRepo });
    const cancelHandler = handlers.get('cancel_appointment')!;
    const forgedProposal = createProposal({
      tenantId: other.tenantId,
      proposalType: 'cancel_appointment',
      payload: { appointmentId, reason: 'cross-tenant cancel attempt' },
      summary: 'cross-tenant cancel attempt',
      createdBy: other.userId,
    });
    const forgedResult = await cancelHandler.execute(forgedProposal, {
      tenantId: other.tenantId,
      executedBy: other.userId,
    });
    expect(forgedResult.success).toBe(false);

    // The real appointment is still canceled from the tenant-A run above —
    // the forged attempt neither reverted nor re-touched it.
    const stillA = await appointmentRepo.findById(tenant.tenantId, appointmentId);
    expect(stillA!.status).toBe('canceled');

    const crossAudit = await pool.query(
      `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_id = $2`,
      [other.tenantId, appointmentId],
    );
    expect(crossAudit.rows).toHaveLength(0);
  });

  it("cancel_appointment is action-classed 'irreversible' and decideInitialStatus never auto-approves it", () => {
    expect(actionClassForProposalType('cancel_appointment')).toBe('irreversible');

    // Sweep every trust tier, a spread of confidences (including a perfect
    // 1.0), every supervisor mode/presence combination, and a permissive
    // tenant threshold override — 'approved' must never come out. Contrast
    // with 'reschedule_appointment' (capture-class), which DOES auto-approve
    // under the matching high-trust/high-confidence/supervised combination —
    // proving this loop would actually catch a regression and isn't
    // vacuously passing because nothing here can ever auto-approve.
    const trustTiers = ['autonomous', 'graduates_fast', 'graduates_slowly', 'always_asks'] as const;
    const confidences = [0, 0.5, 0.9, 0.95, 1.0];
    const supervisorModes = ['supervisor', 'tech', 'both', undefined] as const;
    const supervisorPresentValues = [true, false];

    for (const sourceTrustTier of trustTiers) {
      for (const confidenceScore of confidences) {
        for (const supervisorMode of supervisorModes) {
          for (const supervisorPresent of supervisorPresentValues) {
            const status = decideInitialStatus({
              proposalType: 'cancel_appointment',
              sourceTrustTier,
              confidenceScore,
              supervisorMode,
              supervisorPresent,
              tenantThresholdOverride: { supervisor: 0, tech: 0, both: 0 },
            });
            expect(status).toBe('draft');
          }
        }
      }
    }

    // Positive control: the identical high-trust/high-confidence/supervised
    // combination DOES auto-approve for a capture-class sibling proposal type
    // on this same voice path, so the loop above is proving something real.
    const controlStatus = decideInitialStatus({
      proposalType: 'reschedule_appointment',
      sourceTrustTier: 'autonomous',
      confidenceScore: 1.0,
      supervisorMode: 'both',
      supervisorPresent: true,
    });
    expect(controlStatus).toBe('approved');
  });
});
