/**
 * U4 (Part E punch #1) — tenant timezone on LIVE-CALL datetime parsing,
 * end-to-end against real Postgres.
 *
 * The live-call FSM path (createVoiceTurnProcessor → resolveTurnEntities →
 * resolveSchedulingEntities) used to parse spoken times in a hardcoded UTC
 * frame while the recorded-memo path (voice-action-router →
 * CreateAppointmentAITaskHandler → resolveDateTime) resolved them in the
 * tenant's zone — "the July timezone fixes missed this module"
 * (docs/PRD-v4-part-E-state.md). This file pins the fix on EXECUTED EFFECTS
 * (P-44): the PERSISTED appointment row for a non-UTC tenant.
 *
 *   1. LIVE-CALL leg: an America/Chicago tenant's caller books "2:00 PM" →
 *      classify → resolve (tenant zone from tenant_settings, read once per
 *      session) → confirm → draft → approve → PRODUCTION execution registry
 *      → the appointments row stores 2pm CHICAGO as UTC (19:00Z), never
 *      14:00Z.
 *   2. MEMO-PATH PARITY: the recorded-memo worker books the SAME phrase for
 *      the SAME tenant → its persisted row carries the IDENTICAL instant —
 *      the two entry points no longer disagree.
 *   3. NO-TZ REFUSAL (B5.5 precedent): a tenant with no tenant_settings row
 *      never gets a silently-UTC booking — the live-call draft gates on the
 *      missing window, approveProposal refuses, and no appointment row
 *      exists.
 *
 * The spoken phrase is ABSOLUTE ("August 20 2027 2:00 PM", the same shape
 * the voice-quality corpus derives via absolutePhraseFromIso) so the
 * expected instant is a fixed constant with no wall-clock dependence.
 *
 * Harness mirrors test/voice/inbound-caller-booking-golden-path.test.ts
 * (CVTP speech turns) + test/integration/voice-inbound-appointment.test.ts
 * (approve → production registry → persisted row).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import {
  createVoiceTurnProcessor,
  type VoiceTurnProcessor,
} from '../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { InMemoryVoiceSessionRepository } from '../../src/voice/voice-session';
import { createVoiceActionRouterWorker } from '../../src/workers/voice-action-router';
import { approveProposal } from '../../src/proposals/actions';
import {
  InMemoryProposalRepository,
  Proposal,
  missingFieldsFor,
} from '../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  ExecutionContext,
  createExecutionHandlerRegistry,
} from '../../src/proposals/execution/handlers';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';

const TZ = 'America/Chicago';
// Absolute phrase → fixed expected instant: 2pm CDT (UTC-5) on 2027-08-20.
const SPOKEN_PHRASE = 'August 20 2027 2:00 PM';
const EXPECTED_START_UTC = '2027-08-20T19:00:00.000Z';
// What a UTC-frame parse (the pre-U4 live-call bug) would have stored.
const UTC_FRAME_DECOY = '2027-08-20T14:00:00.000Z';
const REASON = 'Water heater replacement';

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

const BOOKING_CLASSIFICATION = {
  intentType: 'create_appointment',
  confidence: 0.92,
  reasoning: 'caller wants to book a water heater replacement visit',
  extractedEntities: {
    jobReference: REASON,
    dateTimeDescription: SPOKEN_PHRASE,
  },
};
const CONFIRM_YES = { answer: 'yes', reasoning: 'caller confirmed the readback' };

describe('Integration — U4 live-call booking resolves in the tenant timezone (real Postgres)', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;
  let appointmentRepo: PgAppointmentRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    auditRepo = new PgAuditRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedTenant(withTimezone: boolean): Promise<{
    tenantId: string;
    userId: string;
    customerId: string;
  }> {
    const t = await createTestTenant(pool);
    if (withTimezone) {
      await pool.query(
        `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region)
         VALUES ($1, $2, 'Chicago HVAC', $3, 'TX')`,
        [crypto.randomUUID(), t.tenantId, TZ],
      );
    }

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Dana',
      lastName: 'Reyes',
      displayName: 'Dana Reyes',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await locationRepo.create({
      id: crypto.randomUUID(),
      tenantId: t.tenantId,
      customerId,
      street1: '2 Zone St',
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
    return { tenantId: t.tenantId, userId: t.userId, customerId };
  }

  /**
   * Drive the LIVE-CALL path exactly like the golden-path harness: two
   * speech turns (state the booking, confirm the readback) through the real
   * createVoiceTurnProcessor, with the tenant zone coming from the REAL
   * tenant_settings row via PgSettingsRepository — the U4 seam under test.
   */
  async function driveLiveCallBooking(seed: {
    tenantId: string;
    userId: string;
    customerId: string;
  }): Promise<{ proposal: Proposal; proposalRepo: InMemoryProposalRepository }> {
    const store = new VoiceSessionStore({ startInterval: false });
    const proposalRepo = new InMemoryProposalRepository();
    const session = store.create(seed.tenantId, 'telephony', { callSid: `CA-${seed.tenantId.slice(0, 8)}` });
    session.machine.dispatch({
      type: 'incoming_call',
      callSid: session.callSid!,
      from: '+15125550100',
      to: '+15125550999',
      tenantId: seed.tenantId,
    });
    session.machine.dispatch({ type: 'greeted_ok' });
    session.machine.dispatch({ type: 'caller_known', customerId: seed.customerId });
    session.customerId = seed.customerId;

    const processor: VoiceTurnProcessor = createVoiceTurnProcessor({
      store,
      gateway: scriptedGateway([BOOKING_CLASSIFICATION, CONFIRM_YES]),
      businessName: 'Chicago HVAC',
      systemActorId: seed.userId,
      auditRepo,
      proposalRepo,
      voiceSessionRepo: new InMemoryVoiceSessionRepository(),
      settingsRepo,
    });

    await processor.speechTurn({
      session,
      speechResult: `Can someone replace my water heater on ${SPOKEN_PHRASE}?`,
      callSid: session.callSid!,
      tenantId: seed.tenantId,
    });
    await processor.speechTurn({
      session,
      speechResult: 'Yes, that works',
      callSid: session.callSid!,
      tenantId: seed.tenantId,
    });

    const proposals = await proposalRepo.findByTenant(seed.tenantId);
    expect(proposals).toHaveLength(1);
    return { proposal: proposals[0]!, proposalRepo };
  }

  async function approveAndExecute(
    draft: Proposal,
    tenantId: string,
    userId: string,
  ): Promise<string> {
    let proposal = transitionProposal(draft, 'ready_for_review', userId);
    proposal = transitionProposal(proposal, 'approved', userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };

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
    const context: ExecutionContext = { tenantId, executedBy: userId };
    const { result } = await executor.execute(proposal, context);
    expect(result.success).toBe(true);
    return result.resultEntityId!;
  }

  it('live-call "2:00 PM" for an America/Chicago tenant persists 2pm CHICAGO (19:00Z) — and the memo path persists the IDENTICAL instant', async () => {
    const seed = await seedTenant(true);

    // ── Live-call leg ─────────────────────────────────────────────────────
    const { proposal } = await driveLiveCallBooking(seed);
    expect(proposal.proposalType).toBe('create_appointment');
    expect(missingFieldsFor(proposal)).toEqual([]);
    expect(proposal.payload.scheduledStart).toBe(EXPECTED_START_UTC);
    // Human gate: nothing booked until approval.
    expect(proposal.status).toBe('draft');

    const liveAppointmentId = await approveAndExecute(proposal, seed.tenantId, seed.userId);
    const liveRow = await appointmentRepo.findById(seed.tenantId, liveAppointmentId);
    expect(liveRow).not.toBeNull();
    // THE U4 pin, on the persisted row: 2pm in the tenant's zone stored as
    // UTC — and provably NOT the old UTC-frame parse.
    expect(liveRow!.scheduledStart.toISOString()).toBe(EXPECTED_START_UTC);
    expect(liveRow!.scheduledStart.toISOString()).not.toBe(UTC_FRAME_DECOY);

    // ── Memo-path parity leg (same tenant, same phrase) ───────────────────
    const memoProposalRepo = new InMemoryProposalRepository();
    const worker = createVoiceActionRouterWorker({
      gateway: scriptedGateway([
        {
          intentType: 'create_appointment',
          confidence: 0.93,
          extractedEntities: {
            customerName: 'Dana Reyes',
            dateTimeDescription: SPOKEN_PHRASE,
          },
        },
        {
          // Hybrid contract: the model copies the phrase VERBATIM;
          // resolveDateTime owns the calendar math.
          dateTimePhrase: SPOKEN_PHRASE,
          summary: REASON,
          appointmentType: 'repair',
          confidence_score: 0.72,
        },
      ]),
      proposalRepo: memoProposalRepo,
      jobRepo,
      // Same source of truth the live-call leg used: the tenant's REAL
      // settings row.
      tenantSchedulingResolver: async (tenantId: string) => {
        const s = await settingsRepo.findByTenant(tenantId);
        return s?.timezone ? { timezone: s.timezone } : undefined;
      },
    });
    await worker.handle(
      msg({
        tenantId: seed.tenantId,
        userId: seed.userId,
        transcript: `Book Dana Reyes for a water heater replacement ${SPOKEN_PHRASE}`,
      }),
      silentLogger(),
    );

    const memoDrafts = await memoProposalRepo.findByTenant(seed.tenantId);
    expect(memoDrafts).toHaveLength(1);
    expect(memoDrafts[0]!.proposalType).toBe('create_appointment');
    const memoAppointmentId = await approveAndExecute(
      memoDrafts[0]!,
      seed.tenantId,
      seed.userId,
    );
    const memoRow = await appointmentRepo.findById(seed.tenantId, memoAppointmentId);
    expect(memoRow).not.toBeNull();

    // The verification the plan names: identical persisted timestamps for
    // the same utterance + tenant across the two entry points.
    expect(memoRow!.scheduledStart.toISOString()).toBe(EXPECTED_START_UTC);
    expect(memoRow!.scheduledStart.toISOString()).toBe(
      liveRow!.scheduledStart.toISOString(),
    );
  });

  it('no-tz tenant: the live-call draft gates on the missing window, approval REFUSES, and no appointment row exists (never silent UTC)', async () => {
    const seed = await seedTenant(false);

    const { proposal, proposalRepo } = await driveLiveCallBooking(seed);
    expect(proposal.proposalType).toBe('create_appointment');
    // Never a silently-parsed window…
    expect(proposal.payload.scheduledStart).toBeUndefined();
    expect(proposal.payload.scheduledEnd).toBeUndefined();
    // …the draft gates explicitly (B5.5 precedent)…
    expect(missingFieldsFor(proposal)).toEqual(
      expect.arrayContaining(['scheduledStart', 'scheduledEnd']),
    );

    // …approval refuses on the gate…
    await proposalRepo.updateStatus(seed.tenantId, proposal.id, 'ready_for_review');
    await expect(
      approveProposal(proposalRepo, seed.tenantId, proposal.id, seed.userId, 'owner'),
    ).rejects.toThrow(/unfilled required fields/);

    // …and the executed-effect negative: zero appointment rows.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM appointments WHERE tenant_id = $1`,
      [seed.tenantId],
    );
    expect(rows[0].n).toBe(0);
  });
});
