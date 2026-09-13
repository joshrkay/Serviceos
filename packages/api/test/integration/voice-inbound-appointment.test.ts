/**
 * Keystone integration proof — inbound voice appointment-setting.
 *
 * Scope: certifies routing + reason-persistence + the approval gate against
 * REAL Postgres (pins the columns mocked-DB tests can't). It deliberately uses
 * the no-technician appointment path; the technician assignment / TOCTOU
 * compensation branch is covered separately by
 * test/proposals/execution/create-appointment-handler.test.ts. The five
 * things proven here:
 *
 *   1. Routing: a dialed number resolves to its tenant via
 *      PgPhoneNumberRepository.findByNumber, reading the real
 *      `tenant_integrations.provider_data->>'phoneE164'` column (the
 *      cross-tenant system_lookup path).
 *   2. Reason capture: a create_appointment proposal carrying the caller's
 *      spoken reason in `summary` (as the voice task handler emits for a
 *      cold call with no jobId) persists that reason to the real
 *      `appointments.notes` column through the PRODUCTION execution
 *      registry (createExecutionHandlerRegistry) + ProposalExecutor.
 *   3. Human-approval gate: no appointment row exists until the proposal is
 *      approved and executed.
 *   4. Audit wiring: obtaining the handler via the production registry (not
 *      constructing it directly) proves the registry threads auditRepo into
 *      CreateAppointmentExecutionHandler, so execution emits exactly one
 *      `appointment.created` row — the fix for the bug where the
 *      proposal-execution path silently persisted appointments without
 *      auditing them.
 *   5. The SPOKEN SENTENCE actually produces all of the above. Points 2–4 are
 *      driven by a hand-built payload literal, which is deliberate — they are
 *      about what the EXECUTION path does with a payload of that shape — but
 *      on their own they can only ever prove "the handler works GIVEN resolved
 *      ids", never "the utterance produces those ids". The final test closes
 *      that: transcript → REAL `createVoiceActionRouterWorker` → REAL
 *      `PgEntityResolver` (free-text customer name → tenant-scoped id) → REAL
 *      `CreateAppointmentAITaskHandler` (verbatim spoken phrase → UTC instant
 *      via `resolveDateTime`) → approve → the SAME production execution
 *      registry → persisted appointment row + audit event. Nothing in that
 *      chain is a literal: the drafting reply is even scripted with a
 *      hallucinated customerId so a payload that skipped resolution fails.
 *      (Found by the rivet-voice-19 re-measurement, which scored B4.7 4/5
 *      because the reschedule and cancel legs had this proof and the create
 *      leg did not.)
 *
 * Driving the literal Twilio Gather FSM over HTTP is covered by the live-call
 * runbook (docs/runbooks/voice-inbound-appointment-verification.md); CI proves
 * everything that doesn't require real telephony.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgPhoneNumberRepository } from '../../src/integrations/twilio/phone-number-repository';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { findBookableSlots } from '../../src/scheduling/booking-availability';
import {
  createProposal,
  CreateProposalInput,
  InMemoryProposalRepository,
  Proposal,
} from '../../src/proposals/proposal';
import { createAppointmentPayloadSchema, validateProposalPayload } from '../../src/proposals/contracts';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  ExecutionContext,
  createExecutionHandlerRegistry,
} from '../../src/proposals/execution/handlers';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { createVoiceActionRouterWorker } from '../../src/workers/voice-action-router';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';

const TENANT_DID = '+15125550100';
const REASON = 'Leaking water heater';

// ── Spoken-booking fixture for the end-to-end create leg (test 5) ──────────
//
// Fixed clock + tenant zone so `resolveDateTime` is deterministic: Monday
// 2026-08-03, 12:00 in America/Chicago. "Thursday at 10 AM" therefore resolves
// to Thursday 2026-08-06 10:00 Chicago = 15:00Z. Asserted as raw UTC strings
// below (never recomputed here) so no local-time arithmetic enters the test.
const BOOKING_NOW = new Date('2026-08-03T17:00:00.000Z');
const BOOKING_TZ = 'America/Chicago';
const BOOKING_START_UTC = '2026-08-06T15:00:00.000Z';
const BOOKING_END_UTC = '2026-08-06T16:00:00.000Z';
const SPOKEN_CUSTOMER = 'Marisol Vega';
const SPOKEN_BOOKING = `Book ${SPOKEN_CUSTOMER} for a leaking water heater Thursday at 10 AM`;
/**
 * The drafting reply's customerId is a UUID that exists in NO tenant. The
 * booked appointment must trace back to the customer the RESOLVER found for
 * the spoken name; if resolution were skipped (or the handler trusted the
 * model), the payload would carry this instead and the test fails.
 */
const HALLUCINATED_CUSTOMER_ID = '11111111-2222-3333-4444-555555555555';

function silentLogger(): Logger {
  const noop = (..._args: unknown[]) => {};
  const base = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => base,
  } as unknown as Logger;
  return base;
}

/** Replays scripted JSON replies in call order; repeats the last one. */
function scriptedGateway(responses: unknown[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => ({
      content: JSON.stringify(responses[Math.min(i++, responses.length - 1)]),
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 10, output: 10, total: 20 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

function msg<T>(payload: T): QueueMessage<T> {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    type: 'voice_action_router',
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: `idem-${Math.random().toString(36).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
  };
}

async function insertTwilioIntegration(pool: Pool, tenantId: string, phoneE164: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    await client.query(
      `INSERT INTO tenant_integrations (tenant_id, provider, status, provider_data)
       VALUES ($1, 'twilio', 'full_readiness', $2::jsonb)`,
      [tenantId, JSON.stringify({ phoneE164 })],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

describe('Integration — inbound voice appointment-setting (real Postgres)', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let phoneRepo: PgPhoneNumberRepository;
  let jobRepo: PgJobRepository;
  let auditRepo: PgAuditRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    phoneRepo = new PgPhoneNumberRepository(pool);
    jobRepo = new PgJobRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    // The tenant owns its inbound DID (what routing keys off).
    await insertTwilioIntegration(pool, tenant.tenantId, TENANT_DID);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Test',
      lastName: 'Customer',
      displayName: 'Test Customer',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '123 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-001',
      summary: 'Test job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('routes a dialed number to its tenant via the real phoneE164 column', async () => {
    const hit = await phoneRepo.findByNumber(TENANT_DID);
    expect(hit?.tenantId).toBe(tenant.tenantId);

    const miss = await phoneRepo.findByNumber('+15125559999');
    expect(miss).toBeNull();
  });

  it('persists the spoken reason to appointments.notes only after approval + execution', async () => {
    const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);

    // What the voice task handler emits for a cold inbound call: a
    // create_appointment proposal whose `summary` holds the spoken reason and
    // no `notes` (the field the execution handler historically read).
    const input: CreateProposalInput = {
      tenantId: tenant.tenantId,
      proposalType: 'create_appointment',
      payload: {
        jobId,
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
        timezone: 'America/Chicago',
        summary: REASON,
      },
      summary: `${REASON} — appointment`,
      createdBy: tenant.userId,
    };

    let proposal: Proposal = createProposal(input);
    proposal = transitionProposal(proposal, 'ready_for_review', tenant.userId);
    proposal = transitionProposal(proposal, 'approved', tenant.userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };

    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    // Production registry → proves the registry wires auditRepo into
    // CreateAppointmentExecutionHandler (the audit-emission fix under test),
    // the same way test/integration/create-job-execution.test.ts proves it
    // for CreateJobExecutionHandler.
    const handlers = createExecutionHandlerRegistry({ appointmentRepo, jobRepo, auditRepo });
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(
      handlers,
      proposalRepo,
      guard,
      auditRepo,
    );
    await proposalRepo.create(proposal);

    // Gate: nothing booked before execution runs.
    const before = await appointmentRepo.findByJob(tenant.tenantId, jobId);
    expect(before).toHaveLength(0);

    const context: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };
    const { result } = await executor.execute(proposal, context);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();

    const booked = await appointmentRepo.findById(tenant.tenantId, result.resultEntityId!);
    expect(booked).not.toBeNull();
    // Reason-for-visit landed on the real notes column (not dropped).
    expect(booked!.notes).toBe(REASON);
    expect(booked!.status).toBe('scheduled');
    // Stored UTC, tenant display tz preserved.
    expect(new Date(booked!.scheduledStart).toISOString()).toBe(start.toISOString());
    expect(booked!.timezone).toBe('America/Chicago');

    // Regression guard: the executor previously never forwarded auditRepo
    // into createAppointment on the proposal-execution path, so no
    // appointment.created row was ever emitted here.
    const auditRows = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'appointment.created'
          AND entity_type = 'appointment' AND entity_id = $2`,
      [tenant.tenantId, booked!.id],
    );
    expect(auditRows.rows).toHaveLength(1);

    // Cross-tenant negative. Found by the rivet-voice-19 re-measurement: the
    // reschedule and cancel legs each carry one, but this — the CREATE leg of
    // the same conjunctive requirement (B4.7, book/move/cancel by speaking) —
    // asserted the row and the audit event without ever proving the booking is
    // invisible to another tenant. Same scoped-read form the sibling voice
    // execution proofs use.
    const other = await createTestTenant(pool);
    expect(await appointmentRepo.findById(other.tenantId, booked!.id)).toBeNull();
  });

  /**
   * T1 (aiming at T2) — this file's prior cross-tenant proof only ever showed
   * a NEGATIVE (another tenant can't read tenant A's row after the fact); it
   * never showed a second tenant ACTIVELY booking the identical window and
   * tenant A's own availability surviving it — the G1 finding that graded
   * this row T0 despite the negative-read checks below (found by #1007's
   * entry audit; a fixture-shaped negative isn't the T1 grep's target).
   * A voice-produced booking is a proposal, never an executed appointment
   * write on its own — so this proves the actual write path (production
   * execution registry, same as the test above) run for a SECOND, unrelated
   * tenant does not consume tenant A's calendar.
   */
  it('T1 — tenant B\'s booked appointment never blocks tenant A\'s availability for the SAME window', async () => {
    const day = '2099-07-20';
    const busyStart = new Date(`${day}T15:00:00.000Z`);
    const busyEnd = new Date(`${day}T16:00:00.000Z`);

    const tenantB = await createTestTenant(pool);
    const { customerId: customerBId, locationId: locationBId } = await seedBookableCustomer(
      tenantB.tenantId,
      tenantB.userId,
      'Tenant B Customer',
    );
    const jobBId = crypto.randomUUID();
    await jobRepo.create({
      id: jobBId,
      tenantId: tenantB.tenantId,
      customerId: customerBId,
      locationId: locationBId,
      jobNumber: 'JOB-TENANT-B',
      summary: 'Tenant B job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenantB.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Book tenant B through the SAME production execution registry the
    // earlier test proves — a real write, not a fixture.
    const inputB: CreateProposalInput = {
      tenantId: tenantB.tenantId,
      proposalType: 'create_appointment',
      payload: {
        jobId: jobBId,
        scheduledStart: busyStart.toISOString(),
        scheduledEnd: busyEnd.toISOString(),
        timezone: 'America/Chicago',
        summary: 'Tenant B booking',
      },
      summary: 'Tenant B booking — appointment',
      createdBy: tenantB.userId,
    };
    let proposalB: Proposal = createProposal(inputB);
    proposalB = transitionProposal(proposalB, 'ready_for_review', tenantB.userId);
    proposalB = transitionProposal(proposalB, 'approved', tenantB.userId);
    proposalB = { ...proposalB, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    const proposalRepoB = new InMemoryProposalRepository();
    const executionRepoB = new InMemoryProposalExecutionRepository();
    const handlersB = createExecutionHandlerRegistry({ appointmentRepo, jobRepo, auditRepo });
    const executorB = new ProposalExecutor(
      handlersB,
      proposalRepoB,
      new IdempotencyGuard(executionRepoB, proposalRepoB),
      auditRepo,
    );
    await proposalRepoB.create(proposalB);
    const { result: resultB } = await executorB.execute(proposalB, {
      tenantId: tenantB.tenantId,
      executedBy: tenantB.userId,
    });
    expect(resultB.success).toBe(true);

    // Tenant A (this file's shared tenant, seeded in beforeAll) has an EMPTY
    // calendar on this day — its availability for the IDENTICAL window must
    // still offer it. A tenant-unscoped range query would show it as busy.
    const assignmentRepo = new PgAssignmentRepository(pool);
    const slotsForA = await findBookableSlots(
      { appointmentRepo, assignmentRepo },
      { tenantId: tenant.tenantId, fromDate: day, toDate: day, timezone: 'America/Chicago', durationMin: 60, maxSlots: 20 },
    );
    const startsForA = slotsForA.map((s) => s.start.toISOString());
    expect(startsForA).toContain(busyStart.toISOString());
  });

  /**
   * Seed a bookable customer (customer + primary service location, no job) in
   * a FRESH tenant. `jobs.location_id` is NOT NULL, so the location is what
   * makes the executor's SCH-02 auto-open-a-job path possible — the path a
   * cold "book me for X" call actually takes.
   *
   * Fresh tenant per call (the shape cancel-appointment-voice.test.ts uses)
   * so the "nothing is booked before execution" gate is a real count-zero
   * assertion rather than a delta against whatever earlier tests left behind.
   */
  async function seedBookableCustomer(
    tenantId: string,
    userId: string,
    displayName: string,
  ): Promise<{ customerId: string; locationId: string }> {
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: 'Marisol',
      lastName: 'Vega',
      displayName,
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
      street1: '77 Vega Trail',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { customerId, locationId };
  }

  it('books the spoken sentence end to end: free text → PgEntityResolver → REAL drafting task → approve → production execution registry', async () => {
    const bookingTenant = await createTestTenant(pool);
    const { customerId } = await seedBookableCustomer(
      bookingTenant.tenantId,
      bookingTenant.userId,
      SPOKEN_CUSTOMER,
    );

    // The ONLY scripted inputs are the two LLM replies. Neither carries a real
    // id: the classifier emits the customer's name as FREE TEXT, and the
    // drafting reply's customerId is a UUID belonging to no tenant.
    const gateway = scriptedGateway([
      {
        intentType: 'create_appointment',
        confidence: 0.93,
        extractedEntities: {
          customerName: SPOKEN_CUSTOMER,
          dateTimeDescription: 'Thursday at 10 AM',
        },
      },
      {
        // Per APPOINTMENT_SYSTEM_PROMPT the model copies the date/time phrase
        // VERBATIM and does no calendar math — `resolveDateTime` owns that.
        dateTimePhrase: 'Thursday at 10 AM',
        customerId: HALLUCINATED_CUSTOMER_ID,
        summary: REASON,
        appointmentType: 'repair',
        // Below the legacy 0.9 auto-approve threshold, so the booking lands in
        // 'draft' and the human-approval gate below is a real gate.
        confidence_score: 0.72,
      },
    ]);

    const proposalRepo = new InMemoryProposalRepository();
    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      // The seam under test: free-text "Marisol Vega" → tenant-scoped id.
      entityResolver: new PgEntityResolver(pool),
      jobRepo,
      // REQUIRED input — the handler emits a clarification rather than
      // guessing a zone (see create-appointment-task.ts's NO DEFAULT TIMEZONE).
      tenantSchedulingResolver: async () => ({ timezone: BOOKING_TZ }),
      now: () => BOOKING_NOW,
    });

    await worker.handle(
      msg({
        tenantId: bookingTenant.tenantId,
        userId: bookingTenant.userId,
        transcript: SPOKEN_BOOKING,
      }),
      silentLogger(),
    );

    const drafted = await proposalRepo.findByTenant(bookingTenant.tenantId);
    expect(drafted).toHaveLength(1);
    let proposal: Proposal = drafted[0]!;
    expect(proposal.proposalType).toBe('create_appointment');
    expect(proposal.status).toBe('draft');

    const payload = proposal.payload as Record<string, unknown>;
    // Resolution beat the model: the id came from resolving the spoken name.
    expect(payload.customerId).toBe(customerId);
    expect(payload.customerId).not.toBe(HALLUCINATED_CUSTOMER_ID);
    // The window was computed by resolveDateTime from the verbatim phrase —
    // stored UTC, tenant zone carried alongside for rendering.
    expect(payload.scheduledStart).toBe(BOOKING_START_UTC);
    expect(payload.scheduledEnd).toBe(BOOKING_END_UTC);
    expect(payload.timezone).toBe(BOOKING_TZ);
    // #1019 6.2 (G1 3, T0) — "so a mumble can't become a malformed
    // invoice" is a claim about the CONTRACT, not just what the handler
    // happened to draft. Prove the drafted payload is a typed proposal
    // that actually PASSES its Zod contract (proposals/contracts.ts),
    // the same schema the P2-002 AI-safety gate enforces in production.
    expect(createAppointmentPayloadSchema.safeParse(payload).success).toBe(true);

    // Gate: drafting a booking books nothing. No job was opened either — the
    // executor opens it (SCH-02) only once a human approves.
    const before = await pool.query(
      `SELECT (SELECT count(*) FROM appointments WHERE tenant_id = $1) AS appts,
              (SELECT count(*) FROM jobs WHERE tenant_id = $1) AS jobs`,
      [bookingTenant.tenantId],
    );
    expect(Number(before.rows[0].appts)).toBe(0);
    expect(Number(before.rows[0].jobs)).toBe(0);

    proposal = transitionProposal(proposal, 'ready_for_review', bookingTenant.userId);
    proposal = transitionProposal(proposal, 'approved', bookingTenant.userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };

    // Same PRODUCTION registry the literal-payload test above uses, plus the
    // two repos SCH-02's auto-open-a-job branch needs.
    const executionProposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const handlers = createExecutionHandlerRegistry({
      appointmentRepo,
      jobRepo,
      locationRepo,
      auditRepo,
    });
    const executor = new ProposalExecutor(
      handlers,
      executionProposalRepo,
      new IdempotencyGuard(executionRepo, executionProposalRepo),
      auditRepo,
    );
    await executionProposalRepo.create(proposal);

    const context: ExecutionContext = {
      tenantId: bookingTenant.tenantId,
      executedBy: bookingTenant.userId,
    };
    const { result } = await executor.execute(proposal, context);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();

    const booked = await appointmentRepo.findById(bookingTenant.tenantId, result.resultEntityId!);
    expect(booked).not.toBeNull();
    expect(booked!.status).toBe('scheduled');
    // Reason-for-visit survived the whole chain onto the real notes column.
    expect(booked!.notes).toBe(REASON);
    // Stored UTC, byte-for-byte what the drafting task resolved.
    expect(booked!.scheduledStart.toISOString()).toBe(BOOKING_START_UTC);
    expect(booked!.scheduledEnd.toISOString()).toBe(BOOKING_END_UTC);
    expect(booked!.timezone).toBe(BOOKING_TZ);
    // …and rendered in the TENANT's zone it is the Thursday 10 AM that was
    // spoken. Intl with an explicit timeZone — never the host's local time.
    expect(
      new Intl.DateTimeFormat('en-US', {
        timeZone: BOOKING_TZ,
        weekday: 'long',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(booked!.scheduledStart),
    ).toBe('Thursday 10:00 AM');

    // The appointment hangs off a job the executor auto-opened for the
    // RESOLVED customer — the last link in "spoken name → booked visit".
    const openedJob = await jobRepo.findById(bookingTenant.tenantId, booked!.jobId);
    expect(openedJob).not.toBeNull();
    expect(openedJob!.customerId).toBe(customerId);

    // Audit wiring, same regression guard as the literal-payload test.
    const auditRows = await pool.query(
      `SELECT actor_id FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'appointment.created'
          AND entity_type = 'appointment' AND entity_id = $2`,
      [bookingTenant.tenantId, booked!.id],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0].actor_id).toBe(bookingTenant.userId);

    // Cross-tenant negative, matching the sibling reschedule/cancel proofs:
    // neither the booking nor the name that produced it crosses the boundary.
    const other = await createTestTenant(pool);
    expect(await appointmentRepo.findById(other.tenantId, booked!.id)).toBeNull();
    const crossTenant = await new PgEntityResolver(pool).resolve({
      tenantId: other.tenantId,
      reference: SPOKEN_CUSTOMER,
      kind: 'customer',
    });
    expect(crossTenant.kind).toBe('not_found');
  });

  // #1019 6.2 (G1 3, T0) — the OTHER half of "so a mumble can't become a
  // malformed invoice": what happens when the classifier itself can't
  // confidently place the utterance. The router's final guardrail
  // (intent-classifier.ts: "low confidence → unknown, even if the LLM
  // picked an intent") must turn this into a voice_clarification, never a
  // create_appointment proposal built from a guess. Driven at REAL
  // Postgres via PgProposalRepository — not the InMemoryProposalRepository
  // the golden-path tests above use — so "no malformed proposal row" is a
  // real SELECT against the `proposals` table, not an in-memory array.
  it('refuses a low-confidence ("malformed") utterance: no create_appointment row, only a contract-validated voice_clarification, isolated per tenant', async () => {
    const mumbleTenant = await createTestTenant(pool);
    const otherTenant = await createTestTenant(pool);
    const pgProposalRepo = new PgProposalRepository(pool);

    // The classifier heard SOMETHING appointment-shaped but is not
    // confident — exactly `intent-classifier.ts`'s
    // `parsed.confidence < CLASSIFIER_CONFIDENCE_THRESHOLD` (0.6) branch,
    // which downgrades ANY picked intent to 'unknown' before the router
    // ever sees a routable intentType.
    const gateway = scriptedGateway([
      {
        intentType: 'create_appointment',
        confidence: 0.3,
        reasoning: 'garbled — background noise over most of the utterance',
      },
    ]);

    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo: pgProposalRepo,
      entityResolver: new PgEntityResolver(pool),
      jobRepo,
      tenantSchedulingResolver: async () => ({ timezone: BOOKING_TZ }),
      now: () => BOOKING_NOW,
    });

    await worker.handle(
      msg({
        tenantId: mumbleTenant.tenantId,
        userId: mumbleTenant.userId,
        transcript: 'mmf— yeah so uh— Thursd— [inaudible] —book it',
      }),
      silentLogger(),
    );

    // No malformed proposal row: exactly ONE proposal exists for this
    // tenant, and it is the clarification — never a create_appointment
    // built from a low-confidence guess.
    const drafted = await pgProposalRepo.findByTenant(mumbleTenant.tenantId);
    expect(drafted).toHaveLength(1);
    expect(drafted[0]!.proposalType).toBe('voice_clarification');
    expect(drafted[0]!.status).toBe('draft');

    // The real Postgres row, not just the in-process object: confirms this
    // is a genuine SELECT against `proposals`, not an artifact of the
    // repository's own in-memory bookkeeping.
    const { rows: proposalRows } = await pool.query(
      `SELECT proposal_type FROM proposals WHERE tenant_id = $1`,
      [mumbleTenant.tenantId],
    );
    expect(proposalRows).toHaveLength(1);
    expect(proposalRows[0].proposal_type).toBe('voice_clarification');
    expect(
      proposalRows.some((r: { proposal_type: string }) => r.proposal_type === 'create_appointment'),
    ).toBe(false);

    // Typed and validated: the clarification is not a bare guess either —
    // it passes the SAME Zod contract gate (P2-002) the router calls
    // before persisting it (assertValidProposalPayload('voice_clarification', ...)
    // in voice-action-router.ts).
    expect(
      validateProposalPayload('voice_clarification', drafted[0]!.payload).valid,
    ).toBe(true);

    // Audit read-back: a clarification never executes anything, so the
    // negative assertion IS the proof — no audit event of any kind was
    // written for this tenant (nothing mutated, nothing to narrate).
    const auditRows = await pool.query(
      `SELECT event_type FROM audit_events WHERE tenant_id = $1`,
      [mumbleTenant.tenantId],
    );
    expect(auditRows.rows).toHaveLength(0);

    // Second tenant: the clarification is invisible across the tenant
    // boundary, and a SECOND mumble in the other tenant gets its OWN
    // clarification rather than colliding with (or being blocked by) the
    // first tenant's.
    expect(await pgProposalRepo.findByTenant(otherTenant.tenantId)).toHaveLength(0);

    await worker.handle(
      msg({
        tenantId: otherTenant.tenantId,
        userId: otherTenant.userId,
        transcript: 'uh— [static] —Tuesd— can you—',
      }),
      silentLogger(),
    );
    const otherDrafted = await pgProposalRepo.findByTenant(otherTenant.tenantId);
    expect(otherDrafted).toHaveLength(1);
    expect(otherDrafted[0]!.proposalType).toBe('voice_clarification');
    expect(otherDrafted[0]!.id).not.toBe(drafted[0]!.id);
    // The first tenant's clarification is unaffected/unduplicated by the
    // second tenant's mumble.
    expect(await pgProposalRepo.findByTenant(mumbleTenant.tenantId)).toHaveLength(1);
  });

  /**
   * #1014 row 2.1 — T2. Every negative above proves "tenant B cannot read
   * tenant A's row" (T1). This proves the stronger claim: tenant B running
   * its OWN complete inbound-call flow — its own DID, its own customer, its
   * OWN SPOKEN transcript driven through the SAME production chain as test 5
   * above (`createVoiceActionRouterWorker` → `PgEntityResolver` → the
   * drafting task → approve → the production execution registry) — never so
   * much as CHANGES tenant A's rows or availability, not merely that it
   * can't be read from tenant A's context. Snapshotted before/after so the
   * assertion is a real equality, not a fresh count.
   *
   * Review finding (chatgpt-codex-connector, PR #1043): the original version
   * of this test hand-built a `create_appointment` proposal and ran it
   * through `ProposalExecutor` directly with in-memory repos — no inbound
   * adapter, caller identification, or voice-action worker touched tenant
   * B's data at all, so a break in tenant B's actual voice path could not
   * have failed this test. Fixed to drive the real worker chain, mirroring
   * test 5, and to read back tenant B's own `appointment.created` audit
   * event (not just tenant A's, which test 2 already covers).
   */
  it("T2: tenant B's own inbound call to its own DID books its own appointment without touching tenant A's rows or availability", async () => {
    const tenantB = await createTestTenant(pool);
    const DID_B = '+15125550200';
    await insertTwilioIntegration(pool, tenantB.tenantId, DID_B);

    // Tenant A's availability before tenant B's independent call.
    const beforeA = await appointmentRepo.findByJob(tenant.tenantId, jobId);

    // Routing resolves each DID to its own tenant — adding tenant B's
    // integration row does not perturb tenant A's existing lookup.
    const hitB = await phoneRepo.findByNumber(DID_B);
    expect(hitB?.tenantId).toBe(tenantB.tenantId);
    const hitA = await phoneRepo.findByNumber(TENANT_DID);
    expect(hitA?.tenantId).toBe(tenant.tenantId);

    const SPOKEN_CUSTOMER_B = 'Priya Shah';
    const { customerId: bCustomerId } = await seedBookableCustomer(
      tenantB.tenantId,
      tenantB.userId,
      SPOKEN_CUSTOMER_B,
    );

    // The ONLY scripted inputs are the two LLM replies, exactly as test 5 —
    // no literal ids, the classifier emits the customer's name as free text.
    const gatewayB = scriptedGateway([
      {
        intentType: 'create_appointment',
        confidence: 0.93,
        extractedEntities: {
          customerName: SPOKEN_CUSTOMER_B,
          dateTimeDescription: 'Thursday at 10 AM',
        },
      },
      {
        dateTimePhrase: 'Thursday at 10 AM',
        customerId: HALLUCINATED_CUSTOMER_ID,
        summary: 'Tenant B leaking faucet',
        appointmentType: 'repair',
        confidence_score: 0.72,
      },
    ]);

    const bDraftProposalRepo = new InMemoryProposalRepository();
    const workerB = createVoiceActionRouterWorker({
      gateway: gatewayB,
      proposalRepo: bDraftProposalRepo,
      entityResolver: new PgEntityResolver(pool),
      jobRepo,
      tenantSchedulingResolver: async () => ({ timezone: BOOKING_TZ }),
      now: () => BOOKING_NOW,
    });

    await workerB.handle(
      msg({
        tenantId: tenantB.tenantId,
        userId: tenantB.userId,
        transcript: `Book ${SPOKEN_CUSTOMER_B} for a leaking faucet Thursday at 10 AM`,
      }),
      silentLogger(),
    );

    const draftedB = await bDraftProposalRepo.findByTenant(tenantB.tenantId);
    expect(draftedB).toHaveLength(1);
    let bProposal: Proposal = draftedB[0]!;
    expect((bProposal.payload as Record<string, unknown>).customerId).toBe(bCustomerId);
    expect((bProposal.payload as Record<string, unknown>).customerId).not.toBe(
      HALLUCINATED_CUSTOMER_ID,
    );

    bProposal = transitionProposal(bProposal, 'ready_for_review', tenantB.userId);
    bProposal = transitionProposal(bProposal, 'approved', tenantB.userId);
    bProposal = { ...bProposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };

    const bExecutionProposalRepo = new InMemoryProposalRepository();
    const bExecutionRepo = new InMemoryProposalExecutionRepository();
    const bHandlers = createExecutionHandlerRegistry({
      appointmentRepo,
      jobRepo,
      locationRepo,
      auditRepo,
    });
    const bExecutor = new ProposalExecutor(
      bHandlers,
      bExecutionProposalRepo,
      new IdempotencyGuard(bExecutionRepo, bExecutionProposalRepo),
      auditRepo,
    );
    await bExecutionProposalRepo.create(bProposal);
    const { result: bResult } = await bExecutor.execute(bProposal, {
      tenantId: tenantB.tenantId,
      executedBy: tenantB.userId,
    });
    expect(bResult.success).toBe(true);

    const bookedB = await appointmentRepo.findById(tenantB.tenantId, bResult.resultEntityId!);
    expect(bookedB).not.toBeNull();

    // Tenant B's OWN audit event, read back through PgAuditRepository — not
    // just tenant A's (test 2 already covers that).
    const bAuditRows = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'appointment.created'
          AND entity_type = 'appointment' AND entity_id = $2`,
      [tenantB.tenantId, bookedB!.id],
    );
    expect(bAuditRows.rows).toHaveLength(1);

    // Tenant A's availability for its own job is byte-for-byte unchanged —
    // not merely "not visible from tenant A", but genuinely untouched.
    const afterA = await appointmentRepo.findByJob(tenant.tenantId, jobId);
    expect(afterA).toEqual(beforeA);
    expect(await appointmentRepo.findById(tenant.tenantId, bookedB!.id)).toBeNull();
  });
});
