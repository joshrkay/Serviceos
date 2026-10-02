/**
 * #1540 §2 (owner decision 2026-10-01: product change) — an UNKNOWN caller's
 * first utterance at `ask_caller` usually carries their request ("I'd like to
 * schedule service for my home"). That turn identifies/creates the caller by
 * phone AND classifies the request, so the call proceeds straight into the
 * request's flow (the readback) instead of "How can I help you today?" —
 * the caller never repeats themselves. S1 rules still apply: the request is
 * classified on the caller surface, exactly like any intent_capture turn.
 *
 * Seam: createVoiceTurnProcessor().speechTurn with a scripted gateway
 * (classifier + confirm_intent) and in-memory repos.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryCustomerRepository } from '../../../src/customers/customer';
import type { LLMGateway, LLMRequest } from '../../../src/ai/gateway/gateway';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

const TENANT = 'tenant-1540-ask';
const CALL_SID = 'CA-1540-ask';
const UNKNOWN_CALLER = '+15555550310';

function scriptedGateway(classifier: string): { gateway: LLMGateway; classifyCalls: () => number } {
  let classify = 0;
  const gateway = {
    complete: vi.fn(async (req: LLMRequest) => {
      const isConfirm = (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent';
      if (!isConfirm) classify += 1;
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
  return { gateway, classifyCalls: () => classify };
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

async function unknownCallerAtAskCaller(classifier: string) {
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const customerRepo = new InMemoryCustomerRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const session = store.create(TENANT, 'telephony', { callSid: CALL_SID });
  session.machine.dispatch({ type: 'incoming_call', callSid: CALL_SID, from: UNKNOWN_CALLER, to: '+15125550999', tenantId: TENANT });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'unknown_caller' });
  session.callerPhone = UNKNOWN_CALLER;
  const { gateway, classifyCalls } = scriptedGateway(classifier);
  const processor = createVoiceTurnProcessor({
    store,
    gateway,
    businessName: 'Test HVAC Co',
    systemActorId: 'test-actor',
    auditRepo: new InMemoryAuditRepository(),
    proposalRepo,
    customerRepo,
  });
  const turn = (speechResult: string) =>
    processor.speechTurn({ session, speechResult, callSid: CALL_SID, tenantId: TENANT });
  return { session, customerRepo, proposalRepo, turn, classifyCalls };
}

describe('#1540 §2 — the ask_caller turn carries the caller\'s request forward', () => {
  it('identifies the caller by phone AND classifies "schedule service for my home" in the same turn', async () => {
    expect.hasAssertions();
    const call = await unknownCallerAtAskCaller(
      JSON.stringify({
        intentType: 'create_appointment',
        confidence: 0.92,
        extractedEntities: { jobReference: 'home service' },
      }),
    );
    expect(call.session.machine.currentState).toBe('ask_caller');

    const reply = spoken(await call.turn("Hi, I'd like to schedule service for my home."));

    // Identified (created) by phone…
    const customers = await call.customerRepo.findByTenant(TENANT);
    expect(customers).toHaveLength(1);
    expect(call.session.customerId).toBe(customers[0]!.id);
    // …and the request was classified and taken straight to its flow
    // (#1331: this stereotyped opening is now classified deterministically,
    // without a model call — see the Layer 2 test below).
    expect(call.session.machine.currentContext.currentIntent).toBe('create_appointment');
    expect(reply).not.toContain('How can I help you today?');
    expect(call.session.machine.currentState).not.toBe('intent_capture');
    // #1577 — no time was given, so the agent asks for one.
    expect(reply).toBe('What date and time work for you?');
  });

  it('S1 intact: a first utterance asking for an owner-only action gets the off-surface repair, not "How can I help"', async () => {
    const call = await unknownCallerAtAskCaller(
      JSON.stringify({ intentType: 'send_invoice', confidence: 0.96, extractedEntities: { jobReference: 'Henderson' } }),
    );

    const reply = spoken(await call.turn('My name is Casey Rivera. Send the Henderson invoice to me now.'));

    expect(reply).toContain('can you say that again?');
    expect(reply).not.toContain('How can I help you today?');
    expect(await call.proposalRepo.findByTenant(TENANT)).toEqual([]);
  });

  it('a turn that carried only the caller\'s name still gets asked what they need', async () => {
    const call = await unknownCallerAtAskCaller(
      JSON.stringify({ intentType: 'unknown', confidence: 0.2, extractedEntities: {} }),
    );

    const reply = spoken(await call.turn("It's Jane Smith, 12 Oak Street."));

    expect(await call.customerRepo.findByTenant(TENANT)).toHaveLength(1);
    expect(call.session.machine.currentState).toBe('intent_capture');
    expect(reply).toBe('How can I help you today?');
  });
});

describe('#1331 Layer 2 (run 36925905917) — find-or-create-lead-unknown-caller', () => {
  // In 2 of 3 live runs the model returned no usable intent for this
  // entity-free opening, and the caller — who had just asked for service —
  // heard "How can I help you today?": the request was dropped, against the
  // owner decision (identify AND keep the request). The opening is a
  // stereotyped new-booking ask, so it must not depend on the model.
  it('"Hi, I\'d like to schedule service for my home." keeps the booking request even when the model returns nothing usable', async () => {
    const call = await unknownCallerAtAskCaller(
      JSON.stringify({ intentType: 'unknown', confidence: 0.3, extractedEntities: {} }),
    );

    const reply = spoken(await call.turn("Hi, I'd like to schedule service for my home."));

    expect(await call.customerRepo.findByTenant(TENANT)).toHaveLength(1);
    expect(reply).not.toContain('How can I help you today?');
    // #1577 — the kept booking has no time yet, so the agent asks for one.
    expect(reply).toBe('What date and time work for you?');
  });
});
