/**
 * Inbound UNKNOWN caller booking — the customer-creation + linkage proof.
 *
 * Companion to inbound-caller-booking-golden-path.test.ts (which proves a
 * KNOWN caller books). This one proves the harder half of the product promise:
 * a caller whose number is NOT on file dials in, gives their info, and the AI
 *
 *   1. creates a real CUSTOMER keyed by their phone (not just a CRM lead),
 *   2. logs the inbound call on that customer's timeline, and
 *   3. takes the booking — a review-gated create_appointment proposal scoped to
 *      the freshly-created customer.
 *
 * The wire under test: the voice-turn processor's `ask_caller` branch
 * (find-or-create-customer-by-phone → caller_known) — without it the FSM has no
 * way to leave ask_caller (nothing else dispatches caller_known on the Gather
 * path), so an unknown caller could never book.
 */
import { describe, it, expect, vi } from 'vitest';
import { createVoiceTurnProcessor } from '../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryVoiceSessionRepository } from '../../src/voice/voice-session';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import type { Customer, CustomerRepository } from '../../src/customers/customer';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';

const BUSINESS_NUMBER = '+15125550999';
const CALLER_NUMBER = '+15125550100';
const TENANT = 'tenant-hvac-unknown';
const CALL_SID = 'CA-unknown-booking-1';

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

function makeCustomerRepo() {
  const rows: Customer[] = [];
  const repo = {
    create: vi.fn(async (c: Customer) => {
      rows.push(c);
      return c;
    }),
    findById: async (t: string, id: string) => rows.find((r) => r.id === id) ?? null,
    findByTenant: async () => rows,
    update: async () => null,
    search: async () => [],
    findByPhoneNormalized: async () => [], // unknown caller — nothing on file
  } as unknown as CustomerRepository;
  return { repo, rows };
}

const BOOKING_CLASSIFICATION = JSON.stringify({
  intentType: 'create_appointment',
  confidence: 0.92,
  reasoning: 'caller wants to book a furnace repair visit',
  extractedEntities: { jobReference: 'furnace not heating', dateTimeDescription: 'Tuesday at 2pm' },
});
const CONFIRM_YES = JSON.stringify({ answer: 'yes', reasoning: 'caller confirmed the readback' });

describe('Inbound unknown-caller booking', () => {
  it('creates a customer, logs the call, and books a review-gated appointment for them', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const voiceSessionRepo = new InMemoryVoiceSessionRepository();
    const conversationRepo = new InMemoryConversationRepository();
    const { repo: customerRepo, rows: customerRows } = makeCustomerRepo();

    // Drive the inbound FSM to ask_caller: an unknown caller (no caller-ID match).
    const session = store.create(TENANT, 'telephony', { callSid: CALL_SID });
    session.callerPhone = CALLER_NUMBER;
    session.machine.dispatch({ type: 'incoming_call', callSid: CALL_SID, from: CALLER_NUMBER, to: BUSINESS_NUMBER, tenantId: TENANT });
    session.machine.dispatch({ type: 'greeted_ok' });
    session.machine.dispatch({ type: 'unknown_caller' });
    expect(session.machine.currentState).toBe('ask_caller');

    const processor = createVoiceTurnProcessor({
      store,
      gateway: gatewaySequence([BOOKING_CLASSIFICATION, CONFIRM_YES]),
      businessName: 'Rivet HVAC',
      systemActorId: 'calling-agent',
      auditRepo,
      proposalRepo,
      voiceSessionRepo,
      customerRepo,
      conversationRepo,
      callerPhoneResolver: (s) => s.callerPhone,
    });

    // Turn 1 — caller gives their info. The ask_caller wire creates the customer,
    // logs the call, and advances the FSM to intent_capture.
    await processor.speechTurn({
      session,
      speechResult: 'Hi, my name is Dana Reyes and my furnace stopped heating',
      callSid: CALL_SID,
      tenantId: TENANT,
    });

    expect(customerRows).toHaveLength(1); // a real customer was created
    expect(customerRows[0].primaryPhone).toBe(CALLER_NUMBER);
    expect(session.customerId).toBe(customerRows[0].id);
    expect(session.machine.currentState).toBe('intent_capture');

    // The call is on the new customer's timeline.
    const threads = await conversationRepo.findByEntity(TENANT, 'customer', customerRows[0].id);
    expect(threads).toHaveLength(1);
    const msgs = await conversationRepo.getMessages(TENANT, threads[0].id);
    expect(msgs.some((m) => m.source === 'inbound_call')).toBe(true);

    // Turn 2 — caller states the booking → readback (nothing written yet).
    await processor.speechTurn({
      session,
      speechResult: 'Can someone come out Tuesday at 2pm?',
      callSid: CALL_SID,
      tenantId: TENANT,
    });
    expect(session.machine.currentState).toBe('intent_confirm');
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);

    // Turn 3 — caller confirms → the booking proposal is persisted, review-gated,
    // scoped to the tenant the dialed number resolved to.
    await processor.speechTurn({
      session,
      speechResult: 'Yes, that works',
      callSid: CALL_SID,
      tenantId: TENANT,
    });

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('create_appointment');
    expect(proposals[0].status).toBe('draft'); // never auto-executed (CLAUDE.md)
    expect(proposals[0].tenantId).toBe(TENANT);
  });
});
