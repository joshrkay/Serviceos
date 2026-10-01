/**
 * #1540 §3 (owner decision 2026-10-01) — a caller who is ALREADY a customer
 * (recognised by caller ID) asks "can I sign up?". The classifier correctly
 * hears create_customer; the agent must recognise they're already a customer,
 * say so, and ask what they need — never read back "you'd like to add a new
 * customer" and never draft a duplicate create_customer.
 *
 * A caller who was only just created from their phone number on THIS call
 * (the unknown-caller ask_caller path) is not "already a customer": their
 * sign-up (with their name) still drafts.
 *
 * Seam: createVoiceTurnProcessor().speechTurn with a scripted gateway
 * (classifier + confirm_intent) and in-memory repos.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryCustomerRepository, createCustomer } from '../../../src/customers/customer';
import type { LLMGateway, LLMRequest } from '../../../src/ai/gateway/gateway';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

const TENANT = 'tenant-1540-signup';
const CALL_SID = 'CA-1540-signup';

const SIGN_UP = JSON.stringify({ intentType: 'create_customer', confidence: 0.9, extractedEntities: {} });
const SIGN_UP_JANE = JSON.stringify({
  intentType: 'create_customer',
  confidence: 0.92,
  extractedEntities: { displayName: 'Jane Smith' },
});

function scriptedGateway(classifier: string): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest) => {
      const isConfirm = (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent';
      const saidYes = JSON.stringify(req.messages ?? '').includes('Yes, go ahead');
      return {
        content: isConfirm
          ? JSON.stringify({ answer: saidYes ? 'yes' : 'no', reasoning: 'scripted' })
          : classifier,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    }),
  } as unknown as LLMGateway;
}

function spoken(effects: SideEffect[]): string {
  return effects
    .filter((fx) => fx.type === 'tts_play')
    .map((fx) => String(fx.payload.text))
    .join(' ');
}

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

describe('#1540 §3 — an existing customer asking to sign up', () => {
  it('is told they are already a customer and asked what they need — no create_customer draft', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    stores.push(store);
    const customerRepo = new InMemoryCustomerRepository();
    const proposalRepo = new InMemoryProposalRepository();
    const maria = await createCustomer(
      { tenantId: TENANT, firstName: 'Maria', lastName: 'Alvarez', primaryPhone: '+15555550303', createdBy: 'seed' },
      customerRepo,
    );
    const session = store.create(TENANT, 'telephony', { callSid: CALL_SID });
    session.machine.dispatch({ type: 'incoming_call', callSid: CALL_SID, from: '+15555550303', to: '+15125550999', tenantId: TENANT });
    session.machine.dispatch({ type: 'greeted_ok' });
    session.machine.dispatch({ type: 'caller_known', customerId: maria.id });
    session.customerId = maria.id;
    session.callerPhone = '+15555550303';
    const processor = createVoiceTurnProcessor({
      store,
      gateway: scriptedGateway(SIGN_UP),
      businessName: 'Test HVAC Co',
      systemActorId: 'test-actor',
      auditRepo: new InMemoryAuditRepository(),
      proposalRepo,
      customerRepo,
    });
    const turn = (speechResult: string) =>
      processor.speechTurn({ session, speechResult, callSid: CALL_SID, tenantId: TENANT });

    const reply = spoken(await turn('Hi, can I sign up?'));

    // #1331 — the perceived-completion judge rated the bare "let me know
    // what you'd like" as no clear next step: name what the caller can do.
    expect(reply).toBe(
      "I've got you in our system already, so there's nothing to sign up for. I can book a visit, check your balance, or look up an appointment — what would you like?",
    );
    expect(session.machine.currentState).toBe('intent_capture');
    expect(await proposalRepo.findByTenant(TENANT)).toEqual([]);
  });

  it('an unknown caller created from their number on this call still has their sign-up read back', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    stores.push(store);
    const customerRepo = new InMemoryCustomerRepository();
    const proposalRepo = new InMemoryProposalRepository();
    const session = store.create(TENANT, 'telephony', { callSid: CALL_SID });
    session.machine.dispatch({ type: 'incoming_call', callSid: CALL_SID, from: '+15555550301', to: '+15125550999', tenantId: TENANT });
    session.machine.dispatch({ type: 'greeted_ok' });
    session.machine.dispatch({ type: 'unknown_caller' });
    session.callerPhone = '+15555550301';
    const processor = createVoiceTurnProcessor({
      store,
      gateway: scriptedGateway(SIGN_UP_JANE),
      businessName: 'Test HVAC Co',
      systemActorId: 'test-actor',
      auditRepo: new InMemoryAuditRepository(),
      proposalRepo,
      customerRepo,
    });

    const reply = spoken(
      await processor.speechTurn({
        session,
        speechResult: "I'd like to sign up as a new customer. My name is Jane Smith.",
        callSid: CALL_SID,
        tenantId: TENANT,
      }),
    );

    expect(reply).not.toContain('in our system already');
    expect(session.machine.currentState).toBe('intent_confirm');
  });
});
