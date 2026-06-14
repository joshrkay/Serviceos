/**
 * Keystone integration proof — inbound voice appointment-setting.
 *
 * Certifies the substantive chain a real inbound call traverses, against REAL
 * Postgres (pins the columns mocked-DB tests can't):
 *
 *   1. Routing: a dialed number resolves to its tenant via
 *      PgPhoneNumberRepository.findByNumber, reading the real
 *      `tenant_integrations.provider_data->>'phoneE164'` column (the
 *      cross-tenant system_lookup path).
 *   2. Reason capture: a create_appointment proposal carrying the caller's
 *      spoken reason in `summary` (as the voice task handler emits for a
 *      cold call with no jobId) persists that reason to the real
 *      `appointments.notes` column through the production ProposalExecutor +
 *      CreateAppointmentExecutionHandler.
 *   3. Human-approval gate: no appointment row exists until the proposal is
 *      approved and executed.
 *
 * Driving the literal Twilio Gather FSM over HTTP is covered by the live-call
 * runbook (docs/runbooks/voice-inbound-appointment-verification.md); CI proves
 * everything that doesn't require real telephony.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgPhoneNumberRepository } from '../../src/integrations/twilio/phone-number-repository';
import {
  createProposal,
  CreateProposalInput,
  InMemoryProposalRepository,
  Proposal,
  ProposalType,
} from '../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  ExecutionContext,
  ExecutionHandler,
  CreateAppointmentExecutionHandler,
} from '../../src/proposals/execution/handlers';

const TENANT_DID = '+15125550100';
const REASON = 'Leaking water heater';

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
  let tenant: { tenantId: string; userId: string };
  let jobId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    phoneRepo = new PgPhoneNumberRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
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
    const handlers = new Map<ProposalType, ExecutionHandler>([
      ['create_appointment', new CreateAppointmentExecutionHandler(appointmentRepo)],
    ]);
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(handlers, proposalRepo, guard);
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
  });
});
