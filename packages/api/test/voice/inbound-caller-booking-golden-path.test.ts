/**
 * Inbound caller booking — golden-path proof.
 *
 * The product promise behind the AI voice agent: a customer dials the
 * tradesperson's business number and books an appointment by voice, and
 * that booking lands as a HUMAN-APPROVAL proposal — never an
 * auto-executed write. No single per-component test proves that
 * inbound-caller story end to end:
 *
 *   - routes/telephony-tenant-lookup.test.ts proves the dialed number
 *     resolves to the owning tenant (HTTP + Twilio signature, prod-miss
 *     handling),
 *   - voice/operator-voice-golden-path.test.ts proves the OPERATOR voice
 *     path classifies create_appointment,
 *   - ai/tasks/create-appointment-task.test.ts + ai/held-slot-booking-
 *     task.test.ts prove the appointment TASK resolves the spoken time
 *     and holds a slot (at execution / approval time),
 *
 * ...but nothing stitches the INBOUND CALLER turns together: dialed
 * number -> tenant -> "can someone fix my furnace Tuesday at 2?" ->
 * readback -> "yes" -> a review-gated create_appointment proposal scoped
 * to that tenant. The §11 H2 synthetic smoke test left exactly this as a
 * `.todo()` ("routes a canned 'book Tuesday at 2' call to a CreateBooking
 * proposal"). This suite fills that proof at the real inbound engine
 * (`createVoiceTurnProcessor`, which the Twilio Gather adapter delegates
 * `speechTurn` to) with a scripted gateway — no phone network, no STT, no
 * real LLM.
 *
 * Three properties, one story:
 *   1. Routing — the booking lands in the tenant the dialed number
 *      resolves to (PhoneNumberRepository), not a default tenant.
 *   2. Intent + what/when — the caller's utterance classifies as
 *      create_appointment and the extracted job + time ride into the
 *      proposal payload.
 *   3. Human-approval gate — the inbound calling-agent path attaches no
 *      autonomous trust tier, so `decideInitialStatus` lands the proposal
 *      in 'draft': a human must approve before any appointment row is
 *      written. Never auto-executed (CLAUDE.md core pattern).
 *
 * If this suite is red, "a customer can book an appointment by voice" is
 * not proven — don't ship.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createVoiceTurnProcessor,
  type VoiceTurnProcessor,
} from '../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryVoiceSessionRepository } from '../../src/voice/voice-session';
import { InMemoryPhoneNumberRepository } from '../../src/integrations/twilio/phone-number-repository';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';

// The tradesperson's provisioned business number (what the AI answers
// on), the customer's caller-ID, and the tenant that owns the number.
const BUSINESS_NUMBER = '+15125550999';
const CALLER_NUMBER = '+15125550100';
const TENANT = 'tenant-hvac-inbound';
const CALL_SID = 'CA-inbound-booking-1';

/** Gateway that replays one scripted JSON body per `complete()` call. */
function gatewaySequence(contents: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => ({
      content: contents[Math.min(i++, contents.length - 1)],
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 8, output: 8, total: 16 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

interface InboundHarness {
  processor: VoiceTurnProcessor;
  store: VoiceSessionStore;
  proposalRepo: InMemoryProposalRepository;
  auditRepo: InMemoryAuditRepository;
  session: ReturnType<VoiceSessionStore['create']>;
  resolvedTenantId: string;
}

/**
 * Build the inbound engine the way production wires a Gather-mode call,
 * with the one substitution that keeps the test deterministic: the tenant
 * is resolved from the dialed number up front — exactly what
 * `resolveInboundTenantId` in routes/telephony.ts does — instead of from
 * a live Postgres lookup. The cross-tenant number->tenant HTTP path
 * (signature, prod-miss decline) is proven separately in
 * routes/telephony-tenant-lookup.test.ts; here we assert the booking
 * inherits whatever tenant that lookup returns.
 */
async function makeInboundCall(gateway: LLMGateway): Promise<InboundHarness> {
  // Property 1 — the dialed number routes to the owning tenant.
  const phoneRepo = new InMemoryPhoneNumberRepository({ [BUSINESS_NUMBER]: TENANT });
  const lookup = await phoneRepo.findByNumber(BUSINESS_NUMBER);
  if (!lookup) throw new Error('fixture: business number must resolve to a tenant');
  const resolvedTenantId = lookup.tenantId;

  const store = new VoiceSessionStore({ startInterval: false });
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const voiceSessionRepo = new InMemoryVoiceSessionRepository();

  const session = store.create(resolvedTenantId, 'telephony', { callSid: CALL_SID });
  // Drive the inbound FSM to `intent_capture`, the point where a caller
  // utterance is classified. handleInbound's unknown-caller branch lands
  // in `ask_caller`; we emulate the identified-caller transition (the
  // caller-ID match a live pool would perform) so the booking turn runs —
  // the same bootstrap the twilio-adapter Gather tests use.
  session.machine.dispatch({
    type: 'incoming_call',
    callSid: CALL_SID,
    from: CALLER_NUMBER,
    to: BUSINESS_NUMBER,
    tenantId: resolvedTenantId,
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: 'cust-furnace' });
  session.customerId = 'cust-furnace';

  const processor = createVoiceTurnProcessor({
    store,
    gateway,
    businessName: 'Rivet HVAC',
    systemActorId: 'calling-agent',
    auditRepo,
    proposalRepo,
    voiceSessionRepo,
  });

  return { processor, store, proposalRepo, auditRepo, session, resolvedTenantId };
}

// Classifier verdict for a natural inbound booking utterance: the caller
// states WHAT (furnace not heating) and WHEN (Tuesday at 2pm).
const BOOKING_CLASSIFICATION = JSON.stringify({
  intentType: 'create_appointment',
  confidence: 0.92,
  reasoning: 'caller wants to book a furnace repair visit',
  extractedEntities: {
    jobReference: 'furnace not heating',
    dateTimeDescription: 'Tuesday at 2pm',
    customerName: 'Dana Reyes',
  },
});
const CONFIRM_YES = JSON.stringify({
  answer: 'yes',
  reasoning: 'caller confirmed the readback',
});

describe('Inbound caller booking — golden path', () => {
  it('caller books a furnace repair -> review-gated create_appointment in the dialed tenant', async () => {
    const gateway = gatewaySequence([BOOKING_CLASSIFICATION, CONFIRM_YES]);
    const h = await makeInboundCall(gateway);

    // Turn 1 — the caller states the booking. The agent classifies and
    // reads the intent back for confirmation; nothing is written yet.
    await h.processor.speechTurn({
      session: h.session,
      speechResult:
        'Hi, my furnace stopped heating — can someone come out Tuesday at 2pm?',
      callSid: CALL_SID,
      tenantId: h.resolvedTenantId,
    });
    expect(h.session.machine.currentState).toBe('intent_confirm');
    // A guess is never booked: no proposal exists on the readback turn.
    expect(await h.proposalRepo.findByTenant(h.resolvedTenantId)).toHaveLength(0);

    // Turn 2 — the caller confirms. NOW the booking proposal is persisted.
    await h.processor.speechTurn({
      session: h.session,
      speechResult: 'Yes, that works',
      callSid: CALL_SID,
      tenantId: h.resolvedTenantId,
    });

    const proposals = await h.proposalRepo.findByTenant(h.resolvedTenantId);
    expect(proposals).toHaveLength(1);
    const booking = proposals[0]!;

    // Properties 1 + 2 — it's an appointment booking carrying the
    // caller's what + when.
    expect(booking.proposalType).toBe('create_appointment');
    const entities = (booking.payload as { entities: Record<string, unknown> })
      .entities;
    expect(entities.dateTimeDescription).toBe('Tuesday at 2pm');
    expect(entities.jobReference).toBe('furnace not heating');

    // Property 1 — the booking is scoped to the tenant the dialed number
    // resolved to (never leaks to a default).
    expect(booking.tenantId).toBe(TENANT);

    // Property 3 — human-approval gate. The inbound calling-agent path
    // attaches no autonomous trust tier, so the proposal lands in 'draft':
    // a human must approve before any appointment row is written. Never
    // auto-executed.
    expect(booking.status).toBe('draft');
    expect(h.session.proposalIds).toContain(booking.id);
  });

  it('a vague booking the agent is unsure of is never silently booked', async () => {
    // Classifier leans create_appointment but at 0.50 — below the 0.60
    // floor (CLASSIFIER_CONFIDENCE_THRESHOLD) — so classifyIntent returns
    // 'unknown' (low_confidence) and the FSM must NOT fabricate an
    // appointment. Ambiguity becomes a clarification, never a guess
    // (CLAUDE.md voice-path rule).
    const VAGUE = JSON.stringify({
      intentType: 'create_appointment',
      confidence: 0.5,
      reasoning: 'maybe a booking, too vague to act on',
      extractedEntities: { jobReference: 'something with the heat maybe' },
    });
    const gateway = gatewaySequence([VAGUE]);
    const h = await makeInboundCall(gateway);

    await h.processor.speechTurn({
      session: h.session,
      speechResult: 'uh, I dunno, the heat is doing something weird I guess',
      callSid: CALL_SID,
      tenantId: h.resolvedTenantId,
    });

    // No appointment was booked off a low-confidence guess, and the agent
    // did not advance to the confirmation/readback step.
    const proposals = await h.proposalRepo.findByTenant(h.resolvedTenantId);
    expect(proposals.every((p) => p.proposalType !== 'create_appointment')).toBe(
      true,
    );
    expect(h.session.machine.currentState).not.toBe('intent_confirm');
  });
});
