/**
 * D-015 — the autonomous booking lane on the PSTN/Gather transport.
 *
 * Gather runs its own classify call (TwilioGatherAdapter.handleGather), not
 * the processor's speechTurn, so the model-confidence provenance the lane
 * trusts (`confidenceSource`) must be threaded on this transport too. A
 * dropped spread here would leave every Gather booking below_threshold, with
 * the speechTurn suite still green.
 *
 * Seam: TwilioGatherAdapter.handleGather with a scripted gateway and
 * in-memory repos (the gather-owner-decisions-1600 harness).
 *
 * Value: protects=a Gather call from an A-attested known caller auto-books when every gate passes, and only on primary-model confidence;
 *   fails_when=the adapter stops threading confidenceSource, or passes a failover model's score as 'model';
 *   why_new=no test drove handleGather into the booking lane; seam=none;
 *   no_claim=SMS delivery (mocked UNDO sender)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryCustomerRepository, createCustomer } from '../../src/customers/customer';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { autonomousLaneEvaluationFor } from '../../src/proposals/autonomous-lane';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemorySettingsRepository, type TenantSettings } from '../../src/settings/settings';
import { STIR_VERSTAT_FULL_ATTESTATION } from '../../src/telephony/stir-attestation';
import type { EntityResolver } from '../../src/ai/resolution/entity-resolver';

const TENANT = 't-gather-lane';
const TZ = 'America/Chicago';
const CALLER_PHONE = '+15125550142';
const OWNER_CELL = '+15125550888';
const JOB_ID = '44444444-3333-4333-8333-333333333333';

/** The model, scripted: a 0.97 booking for every classify call; a yes to every readback. */
function scriptedGateway(opts: { fallbackStage?: string }): LLMGateway {
  return {
    complete: vi.fn(async (request: LLMRequest) => {
      const user = request.messages.find((m) => m.role === 'user')?.content ?? '';
      const content = user.includes("Classify the caller's response as YES or NO.")
        ? JSON.stringify({ answer: 'yes', reasoning: 'scripted' })
        : JSON.stringify({
            intentType: 'create_appointment',
            confidence: 0.97,
            extractedEntities: {
              jobReference: 'furnace not heating',
              dateTimeDescription: 'Tuesday at 2pm',
            },
          });
      return {
        content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
        ...(opts.fallbackStage ? { degraded: true, fallbackStage: opts.fallbackStage } : {}),
      } satisfies LLMResponse;
    }),
  } as unknown as LLMGateway;
}

const jobResolver: EntityResolver = {
  async resolve({ kind }) {
    if (kind === 'job') {
      return {
        kind: 'resolved',
        candidate: { id: JOB_ID, kind: 'job', label: 'Furnace not heating', score: 1 },
      };
    }
    return { kind: 'skipped' };
  },
};

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

async function bookOverGather(opts: { fallbackStage?: string } = {}) {
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const customerRepo = new InMemoryCustomerRepository();
  const caller = await createCustomer(
    { tenantId: TENANT, firstName: 'Dana', lastName: 'Lee', primaryPhone: CALLER_PHONE, createdBy: 'seed' },
    customerRepo,
  );
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({
    tenantId: TENANT,
    timezone: TZ,
    autonomousBookingEnabled: true,
    autonomousBookingThreshold: 0.95,
    ownerPhone: OWNER_CELL,
  } as TenantSettings);
  const proposalRepo = new InMemoryProposalRepository();
  const laneUndo = {
    sendSms: vi.fn(async (_to: string, _body: string) => {}),
    secret: 'test-one-tap-secret',
    buildUndoUrl: (token: string) => `https://api.example.com/undo?token=${token}`,
    canDeliver: () => true,
  };
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: scriptedGateway(opts),
    businessName: 'Rivet HVAC',
    publicBaseUrl: 'https://example.com',
    auditRepo: new InMemoryAuditRepository(),
    proposalRepo,
    customerRepo,
    appointmentRepo: new InMemoryAppointmentRepository(),
    settingsRepo,
    entityResolver: jobResolver,
    laneUndo,
    slotConflictChecker: { check: async () => ({ ok: true as const }) },
  });
  const callSid = 'CA-gather-lane';
  await adapter.handleInbound({
    callSid,
    from: CALLER_PHONE,
    to: '+15125550000',
    tenantId: TENANT,
    stirVerstat: STIR_VERSTAT_FULL_ATTESTATION,
  });
  const session = store.findByCallSid(callSid)!;
  // Caller-ID matched the customer (no Pool here, so the match is applied directly).
  session.machine.dispatch({ type: 'caller_known', customerId: caller.id });
  session.customerId = caller.id;
  const gather = (speechResult: string) =>
    adapter.handleGather({ sessionId: session.id, callSid, speechResult, confidence: 0.9, tenantId: TENANT });

  await gather('My furnace stopped heating, can someone come Tuesday at 2pm?');
  await gather('Yes, that works');

  const booking = (await proposalRepo.findByTenant(TENANT)).find(
    (p) => p.proposalType === 'create_booking',
  );
  return { booking, laneUndo };
}

describe('Gather transport — D-015 autonomous booking lane', () => {
  it('an A-attested known caller with every gate passing is auto-booked and the owner gets one UNDO text', async () => {
    const { booking, laneUndo } = await bookOverGather();
    expect(booking).toBeDefined();
    expect(autonomousLaneEvaluationFor(booking!)).toEqual({ eligible: true, threshold: 0.95 });
    expect(booking!.status).toBe('approved');
    await vi.waitFor(() => expect(laneUndo.sendSms).toHaveBeenCalledTimes(1));
    expect(laneUndo.sendSms).toHaveBeenCalledWith(OWNER_CELL, expect.stringContaining('Tap to UNDO'));
  });

  it('a failover model classification never auto-books (below_threshold)', async () => {
    const { booking, laneUndo } = await bookOverGather({ fallbackStage: 'fallback-provider' });
    expect(booking).toBeDefined();
    expect(booking!.status).toBe('draft');
    expect(autonomousLaneEvaluationFor(booking!)).toEqual({
      eligible: false,
      reason: 'below_threshold',
    });
    expect(laneUndo.sendSms).not.toHaveBeenCalled();
  });
});
