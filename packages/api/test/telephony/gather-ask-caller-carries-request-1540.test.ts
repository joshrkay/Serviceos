/**
 * #1540 §2 (owner decision 2026-10-01) — on the PSTN/Gather path too, the
 * unknown caller's ask_caller answer is identified by phone AND its request
 * is classified in the same turn, so the call goes straight to the readback
 * instead of "How can I help you today?".
 *
 * Seam: TwilioGatherAdapter.handleGather with a scripted gateway and
 * in-memory repos (the ask-caller-gather.test.ts harness).
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryCustomerRepository, createCustomer } from '../../src/customers/customer';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';

const TENANT = 't-1540-gather-ask';
const CALLER_PHONE = '+15125557790';

function scriptedGateway(classifier: string): LLMGateway {
  return {
    complete: vi.fn(
      async () =>
        ({
          content: classifier,
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

describe('#1540 §2 — Gather: the ask_caller turn carries the request forward', () => {
  it('"I\'d like to schedule service for my home" → caller created by phone AND read back, no "How can I help"', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const customerRepo = new InMemoryCustomerRepository();
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: scriptedGateway(
        JSON.stringify({
          intentType: 'create_appointment',
          confidence: 0.92,
          extractedEntities: { jobReference: 'home service' },
        }),
      ),
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://example.com',
      auditRepo: new InMemoryAuditRepository(),
      proposalRepo: new InMemoryProposalRepository(),
      customerRepo,
    });
    await adapter.handleInbound({ callSid: 'CA-1540-g', from: CALLER_PHONE, to: '+15125550000', tenantId: TENANT });
    const session = store.findByCallSid('CA-1540-g')!;
    expect(session.machine.currentState).toBe('ask_caller');

    const twiml = await adapter.handleGather({
      sessionId: session.id,
      callSid: 'CA-1540-g',
      speechResult: "Hi, I'd like to schedule service for my home.",
      confidence: 0.9,
      tenantId: TENANT,
    });

    expect(session.customerId).toBeTruthy();
    expect(session.machine.currentState).toBe('intent_confirm');
    expect(twiml).toContain('Just to confirm');
    expect(twiml).not.toContain('How can I help you today?');
  });
});

describe('#1540 §2 — S1 intact: an off-surface request on the carry-forward turn', () => {
  it('a stranger\'s FIRST utterance asking for an owner-only action is intercepted exactly like any caller turn — repair, not "How can I help"', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: scriptedGateway(
        JSON.stringify({ intentType: 'send_invoice', confidence: 0.96, extractedEntities: { jobReference: 'Henderson' } }),
      ),
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://example.com',
      auditRepo,
      proposalRepo,
      customerRepo: new InMemoryCustomerRepository(),
    });
    await adapter.handleInbound({ callSid: 'CA-1540-g5', from: '+15555550399', to: '+15125550000', tenantId: TENANT });
    const session = store.findByCallSid('CA-1540-g5')!;
    expect(session.machine.currentState).toBe('ask_caller');

    const twiml = await adapter.handleGather({
      sessionId: session.id,
      callSid: 'CA-1540-g5',
      speechResult: 'My name is Casey Rivera. Please send the Henderson invoice to me right now.',
      confidence: 0.9,
      tenantId: TENANT,
    });

    expect(auditRepo.getAll().filter((e) => e.eventType === 'voice.intent_off_surface')).toHaveLength(1);
    expect(await proposalRepo.findByTenant(TENANT)).toEqual([]);
    expect(twiml).toContain('can you say that again?');
    expect(twiml).not.toContain('How can I help you today?');
  });
});

describe('#1540 §3 — Gather: an existing customer asking to sign up', () => {
  it('is told they are already a customer and asked what they need — no create_customer draft', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const customerRepo = new InMemoryCustomerRepository();
    const proposalRepo = new InMemoryProposalRepository();
    const maria = await createCustomer(
      { tenantId: TENANT, firstName: 'Maria', lastName: 'Alvarez', primaryPhone: '+15555550303', createdBy: 'seed' },
      customerRepo,
    );
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: scriptedGateway(JSON.stringify({ intentType: 'create_customer', confidence: 0.9, extractedEntities: {} })),
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://example.com',
      auditRepo: new InMemoryAuditRepository(),
      proposalRepo,
      customerRepo,
    });
    await adapter.handleInbound({ callSid: 'CA-1540-g3', from: '+15555550303', to: '+15125550000', tenantId: TENANT });
    const session = store.findByCallSid('CA-1540-g3')!;
    // Caller-ID matched Maria (no Pool here, so the match is applied directly).
    session.machine.dispatch({ type: 'caller_known', customerId: maria.id });
    session.customerId = maria.id;

    const twiml = await adapter.handleGather({
      sessionId: session.id,
      callSid: 'CA-1540-g3',
      speechResult: 'Hi, can I sign up?',
      confidence: 0.9,
      tenantId: TENANT,
    });

    expect(twiml).toContain('in our system already');
    expect(session.machine.currentState).toBe('intent_capture');
    expect(await proposalRepo.findByTenant(TENANT)).toEqual([]);
  });

  it('an unknown caller created from their number THIS call is not told they are already a customer', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const proposalRepo = new InMemoryProposalRepository();
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: scriptedGateway(
        JSON.stringify({
          intentType: 'create_customer',
          confidence: 0.92,
          extractedEntities: { displayName: 'Jane Smith' },
        }),
      ),
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://example.com',
      auditRepo: new InMemoryAuditRepository(),
      proposalRepo,
      customerRepo: new InMemoryCustomerRepository(),
    });
    await adapter.handleInbound({ callSid: 'CA-1540-g4', from: '+15555550301', to: '+15125550000', tenantId: TENANT });
    const session = store.findByCallSid('CA-1540-g4')!;
    expect(session.machine.currentState).toBe('ask_caller');

    const twiml = await adapter.handleGather({
      sessionId: session.id,
      callSid: 'CA-1540-g4',
      speechResult: "I'd like to sign up as a new customer. My name is Jane Smith.",
      confidence: 0.9,
      tenantId: TENANT,
    });

    expect(twiml).not.toContain('in our system already');
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(1);
  });
});
