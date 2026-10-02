/**
 * #1538 — the phone turn engine (createVoiceTurnProcessor().speechTurn,
 * behind media streams): a caller who answers the `intent_confirm` readback
 * with a missing DETAIL ("Tuesday at 2pm") instead of yes/no must not lose
 * the request. The detail is merged into the pending request and the
 * readback is spoken again — in-app parity (D01 / Train-7). An explicit
 * "no", or a clearly different request, still corrects.
 *
 * Seam: speechTurn with a scripted gateway (classifier + confirm_intent) and
 * in-memory repos — the #1476 speechTurn harness.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryCustomerRepository, createCustomer } from '../../../src/customers/customer';
import type { LLMGateway, LLMRequest } from '../../../src/ai/gateway/gateway';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';
import { InMemorySettingsRepository } from '../../../src/settings/settings';
import { InMemoryAppointmentRepository } from '../../../src/appointments/appointment';

const TENANT = 'tenant-1538-phone';
const CALL_SID = 'CA-1538';
const CALLER_ID = '+15125550100';

/** The bare time fragment the caller answers the readback with. */
const TIME_ONLY = JSON.stringify({
  intentType: 'unknown',
  confidence: 0.4,
  extractedEntities: { dateTimeDescription: 'Tuesday at 2pm' },
});
const DIFFERENT_REQUEST = JSON.stringify({
  intentType: 'send_invoice',
  confidence: 0.93,
  extractedEntities: { customerName: 'Henderson' },
});

/**
 * The classifier answers by what the caller said (turn 1, "book a service
 * appointment", never reaches the model: the classifier's deterministic
 * booking rule answers it). confirm_intent says "yes" only to "Yes, that's
 * right" — a detail is not a yes, which is exactly why it used to become a
 * correction.
 */
function phoneGateway(byUtterance: Record<string, string>): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest) => {
      const isConfirm =
        (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent';
      const said = JSON.stringify(req.messages ?? '');
      const saidYes = /Yes, that's right/.test(said);
      const scripted = Object.entries(byUtterance).find(([utterance]) => said.includes(utterance));
      return {
        content: isConfirm
          ? JSON.stringify({ answer: saidYes ? 'yes' : 'no', reasoning: 'scripted' })
          : (scripted?.[1] ?? JSON.stringify({ intentType: 'unknown', confidence: 0.2, extractedEntities: {} })),
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    }),
  } as unknown as LLMGateway;
}

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

async function makeCall(byUtterance: Record<string, string> = {}) {
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const proposalRepo = new InMemoryProposalRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const customer = await createCustomer(
    {
      tenantId: TENANT,
      firstName: 'Dana',
      lastName: 'Reyes',
      primaryPhone: '+14805550199',
      createdBy: 'test',
    },
    customerRepo,
  );
  const session = store.create(TENANT, 'telephony', { callSid: CALL_SID });
  session.machine.dispatch({
    type: 'incoming_call',
    callSid: CALL_SID,
    from: CALLER_ID,
    to: '+15125550999',
    tenantId: TENANT,
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: customer.id });
  session.customerId = customer.id;
  session.callerPhone = CALLER_ID;
  const processor = createVoiceTurnProcessor({
    store,
    gateway: phoneGateway(byUtterance),
    businessName: 'Acme Plumbing',
    systemActorId: 'test-actor',
    auditRepo: new InMemoryAuditRepository(),
    proposalRepo,
    customerRepo,
  });
  const turn = (speechResult: string) =>
    processor.speechTurn({ session, speechResult, callSid: CALL_SID, tenantId: TENANT });
  return { session, proposalRepo, turn };
}

function spoken(sideEffects: SideEffect[]): string {
  return sideEffects
    .filter((fx) => fx.type === 'tts_play')
    .map((fx) => String(fx.payload.text))
    .join(' ');
}

describe('#1538 — phone: a detail given at the readback', () => {
  it('merges the detail into the pending booking, reads back again, and the yes drafts it', async () => {
    const { session, proposalRepo, turn } = await makeCall({ 'Tuesday at 2pm': TIME_ONLY });
    await turn('I want to book a service appointment.');
    expect(session.machine.currentState).toBe('intent_confirm');

    const reply = spoken(await turn('Tuesday at 2pm.'));
    expect(session.machine.currentState).toBe('intent_confirm');
    expect(reply).not.toMatch(/let me try again/i);
    expect(reply).toMatch(/Is that right\?/);
    expect(session.machine.currentContext.currentIntent).toBe('create_appointment');
    expect(session.machine.currentContext.extractedEntities?.dateTimeDescription).toBe(
      'Tuesday at 2pm',
    );

    await turn("Yes, that's right.");
    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('create_appointment');
  });

  // #1331 — Layer 2 run 36895893912 (two-step-booking, all 3 runs): the live
  // classifier named no intent AND extracted no slot from the bare answer
  // "Tuesday at 2pm.", so nothing merged and the caller heard the same
  // "…with no day or time yet. Is that right?" again; the yes then drafted a
  // booking with no time. A booking still missing its WHEN, answered with a
  // phrase that IS a day/time, takes that phrase as the time.
  it('takes a bare day/time answer as the booking time even when the classifier extracted nothing', async () => {
    const NOTHING = JSON.stringify({ intentType: 'unknown', confidence: 0.3, extractedEntities: {} });
    const { session, proposalRepo, turn } = await makeCall({ 'Tuesday at 2pm': NOTHING });
    await turn('I want to book a service appointment.');

    const reply = spoken(await turn('Tuesday at 2pm.'));
    expect(reply).toBe("Just to confirm — you'd like to schedule an appointment, Tuesday at 2pm. Is that right?");
    expect(session.machine.currentContext.extractedEntities?.dateTimeDescription).toBe('Tuesday at 2pm');

    await turn("Yes, that's right.");
    expect((await proposalRepo.findByTenant(TENANT)).map((p) => p.proposalType)).toEqual(['create_appointment']);
  });

  it('an answer that is not a day/time still merges nothing (the date-and-time question is re-asked)', async () => {
    const NOTHING = JSON.stringify({ intentType: 'unknown', confidence: 0.3, extractedEntities: {} });
    const { session, turn } = await makeCall({ 'whatever works': NOTHING });
    await turn('I want to book a service appointment.');
    const reply = spoken(await turn('Hmm, whatever works for you.'));
    // #1577 — a timeless booking is asked for its time, not read back.
    expect(reply).toBe('What date and time work for you?');
    expect(session.machine.currentContext.extractedEntities?.dateTimeDescription).toBeUndefined();
  });
});

describe('#1331 Layer 2 (run 36925905917) — two-step booking, known customer', () => {
  // Criterion 9 failed on all 3 runs: "turn 1: expected intent
  // 'create_appointment', got 'unknown'". The caller's "Tuesday at 2pm." is
  // the day/time for the booking they are confirming — the turn's request
  // is still that booking, not an unknown one.
  it('the day/time answer at the readback is reported as the booking request it continues', async () => {
    const NOTHING = JSON.stringify({ intentType: 'unknown', confidence: 0.3, extractedEntities: {} });
    const { session, turn } = await makeCall({ 'Tuesday at 2pm': NOTHING });
    const intents: string[] = [];
    session.events.on('voice-event', (e: { type: string; intentType?: string }) => {
      if (e.type === 'intent_classified' && e.intentType) intents.push(e.intentType);
    });
    await turn('I want to book a service appointment.');
    await turn('Tuesday at 2pm.');

    expect(intents).toEqual(['create_appointment', 'create_appointment']);
  });

  // Criterion 12, run 0: the yes was answered "I've noted that appointment
  // request. Someone from our team will confirm the time with you shortly."
  // — no time, and nothing saying what was done. The request WAS drafted,
  // with the time the caller gave; the expected answer (corpus) is "I've
  // drafted a service appointment for Tuesday May 5 at 2pm; an operator will
  // confirm before it's booked."
  it('the yes says the appointment was drafted for the time given, pending confirmation', async () => {
    const NOTHING = JSON.stringify({ intentType: 'unknown', confidence: 0.3, extractedEntities: {} });
    const store = new VoiceSessionStore({ startInterval: false });
    stores.push(store);
    const proposalRepo = new InMemoryProposalRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const settingsRepo = new InMemorySettingsRepository();
    await settingsRepo.create({
      id: 'settings-two-step',
      tenantId: TENANT,
      businessName: 'Test HVAC Co',
      timezone: 'America/Los_Angeles',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Parameters<InMemorySettingsRepository['create']>[0]);
    const jane = await createCustomer(
      { tenantId: TENANT, firstName: 'Jane', lastName: 'Smith', primaryPhone: '+15555550204', createdBy: 'test' },
      customerRepo,
    );
    const session = store.create(TENANT, 'telephony', { callSid: CALL_SID });
    session.machine.dispatch({ type: 'incoming_call', callSid: CALL_SID, from: '+15555550204', to: '+15125550999', tenantId: TENANT });
    session.machine.dispatch({ type: 'greeted_ok' });
    session.machine.dispatch({ type: 'caller_known', customerId: jane.id });
    session.customerId = jane.id;
    session.callerPhone = '+15555550204';
    const processor = createVoiceTurnProcessor({
      store,
      gateway: phoneGateway({
        'book a service appointment': JSON.stringify({ intentType: 'create_appointment', confidence: 0.95, extractedEntities: {} }),
        'Tuesday at 2pm': NOTHING,
      }),
      businessName: 'Test HVAC Co',
      systemActorId: 'test-actor',
      auditRepo: new InMemoryAuditRepository(),
      proposalRepo,
      customerRepo,
      appointmentRepo: new InMemoryAppointmentRepository(),
      settingsRepo,
      // Friday 2026-05-01 in Los Angeles — "Tuesday" is May 5.
      now: () => new Date('2026-05-01T12:00:00.000Z'),
    });
    const turn = async (speechResult: string) =>
      spoken(await processor.speechTurn({ session, speechResult, callSid: CALL_SID, tenantId: TENANT }));

    await turn('Hi, this is Jane Smith. I want to book a service appointment.');
    await turn('Tuesday at 2pm.');
    const reply = await turn("Yes, that's right.");

    expect(reply).not.toMatch(/noted that appointment request/i);
    expect(reply).toMatch(/drafted/i);
    expect(reply).toMatch(/Tuesday, May 5/);
    expect(reply).toMatch(/2(:00)?\s?PM/i);
    expect(reply).toMatch(/confirm/i);
  });
});

describe('#1331 — phone: the yes/no model is unreachable at the readback', () => {
  // Run 36895893912 logged "speechTurn: confirmIntent failed — All providers
  // failed. Last error: Request was aborted." twice; each time a plain "Yes,
  // that's right." became a correction ("My apologies — let me try again")
  // and the confirmed request was thrown away. In-app already decides a
  // plain yes deterministically (confirm-turn.ts isAffirmation).
  function confirmDownGateway(classifier: string): LLMGateway {
    return {
      complete: vi.fn(async (req: LLMRequest) => {
        if ((req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent') {
          throw new Error('All providers failed. Last error: Request was aborted.');
        }
        return { content: classifier, model: 'mock', provider: 'mock', tokenUsage: { input: 1, output: 1, total: 2 }, latencyMs: 1 };
      }),
    } as unknown as LLMGateway;
  }

  async function callWith(gateway: LLMGateway) {
    const store = new VoiceSessionStore({ startInterval: false });
    stores.push(store);
    const proposalRepo = new InMemoryProposalRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const customer = await createCustomer(
      { tenantId: TENANT, firstName: 'Dana', lastName: 'Reyes', primaryPhone: '+14805550199', createdBy: 'test' },
      customerRepo,
    );
    const session = store.create(TENANT, 'telephony', { callSid: CALL_SID });
    session.machine.dispatch({ type: 'incoming_call', callSid: CALL_SID, from: CALLER_ID, to: '+15125550999', tenantId: TENANT });
    session.machine.dispatch({ type: 'greeted_ok' });
    session.machine.dispatch({ type: 'caller_known', customerId: customer.id });
    session.customerId = customer.id;
    session.callerPhone = CALLER_ID;
    const processor = createVoiceTurnProcessor({
      store, gateway, businessName: 'Acme Plumbing', systemActorId: 'test-actor',
      auditRepo: new InMemoryAuditRepository(), proposalRepo, customerRepo,
    });
    const turn = (speechResult: string) =>
      processor.speechTurn({ session, speechResult, callSid: CALL_SID, tenantId: TENANT });
    return { session, proposalRepo, turn };
  }

  const BOOK = JSON.stringify({
    intentType: 'create_appointment',
    confidence: 0.95,
    extractedEntities: { dateTimeDescription: 'Tuesday at 2pm' },
  });

  it('a plain yes still drafts the confirmed request', async () => {
    const { proposalRepo, turn } = await callWith(confirmDownGateway(BOOK));
    await turn('Book me for Tuesday at 2pm.');
    const reply = spoken(await turn("Yes, that's right."));
    expect(reply).not.toMatch(/let me try again/i);
    expect((await proposalRepo.findByTenant(TENANT)).map((p) => p.proposalType)).toEqual(['create_appointment']);
  });

  it('anything that is not a plain yes is still not taken as one', async () => {
    const { proposalRepo, turn } = await callWith(confirmDownGateway(BOOK));
    await turn('Book me for Tuesday at 2pm.');
    await turn('Hmm, hold on a second.');
    expect(await proposalRepo.findByTenant(TENANT)).toEqual([]);
  });
});

describe('#1538 — phone: a real correction at the readback still corrects', () => {
  it('an explicit "no" drops the pending request', async () => {
    const { session, proposalRepo, turn } = await makeCall();
    await turn('I want to book a service appointment.');
    expect(session.machine.currentState).toBe('intent_confirm');

    await turn("No, that's wrong.");
    expect(session.machine.currentState).toBe('intent_capture');
    expect(session.machine.currentContext.currentIntent).toBeUndefined();
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('a different request is a correction, never folded into the booking', async () => {
    const { session, proposalRepo, turn } = await makeCall({
      'send the Henderson invoice': DIFFERENT_REQUEST,
    });
    await turn('I want to book a service appointment.');

    await turn('Actually, send the Henderson invoice.');
    expect(session.machine.currentState).toBe('intent_capture');
    expect(session.machine.currentContext.extractedEntities?.customerName).toBeUndefined();
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });
});
