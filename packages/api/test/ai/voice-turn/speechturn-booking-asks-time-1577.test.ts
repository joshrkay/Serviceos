/**
 * #1577 — a phone booking with no day or time used to be read back as
 * "Just to confirm — you'd like to schedule an appointment, with no day or
 * time yet. Is that right?" (Layer 2 runs 36925905917 / 36938493716:
 * two-step-booking-known-customer and find-or-create-lead-unknown-caller,
 * flagged by the criterion-12 judge every run). The agent asks for the
 * date and time FIRST, then reads the booking back.
 *
 * Seam: createVoiceTurnProcessor().speechTurn with a scripted gateway and
 * in-memory repos (the #1538 harness).
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

const TENANT = 'tenant-1577-phone';
const CALL_SID = 'CA-1577';
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

describe('#1577 — phone: a booking with no day or time asks for one', () => {
  it('asks "What date and time work for you?" instead of reading back a booking with no time', async () => {
    const { session, turn } = await makeCall();
    const reply = spoken(await turn('I want to book a service appointment.'));

    expect(reply).toBe('What date and time work for you?');
    expect(session.machine.currentContext.currentIntent).toBe('create_appointment');
  });

  it('a yes to the date-and-time question drafts nothing and asks again', async () => {
    const { session, proposalRepo, turn } = await makeCall();
    await turn('I want to book a service appointment.');

    const reply = spoken(await turn("Yes, that's right."));

    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
    expect(reply).toBe('What date and time work for you?');
    expect(session.machine.currentContext.currentIntent).toBe('create_appointment');
  });

  it('the day and time answer is read back, and the yes drafts the booking with that time', async () => {
    const { session, proposalRepo, turn } = await makeCall({ 'Tuesday at 2pm': TIME_ONLY });
    await turn('I want to book a service appointment.');

    const reply = spoken(await turn('Tuesday at 2pm.'));
    expect(reply).toBe(
      "Just to confirm — you'd like to schedule an appointment, Tuesday at 2pm. Is that right?",
    );

    await turn("Yes, that's right.");
    const [proposal] = await proposalRepo.findByTenant(TENANT);
    expect(proposal?.proposalType).toBe('create_appointment');
    expect(session.machine.currentContext.extractedEntities?.dateTimeDescription).toBe('Tuesday at 2pm');
  });

  it('a "no" to the date-and-time question still corrects', async () => {
    const { session, proposalRepo, turn } = await makeCall();
    await turn('I want to book a service appointment.');

    const reply = spoken(await turn('No.'));

    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
    expect(reply).toMatch(/let me try again/i);
    expect(session.machine.currentContext.currentIntent).toBeUndefined();
  });

  it('a Spanish-language call is asked in Spanish', async () => {
    const { session, turn } = await makeCall({
      'Quiero reservar': JSON.stringify({
        intentType: 'create_appointment',
        confidence: 0.93,
        extractedEntities: {},
      }),
    });
    session.language = 'es';

    const reply = spoken(await turn('Quiero reservar una cita de servicio.'));

    expect(reply).toBe('¿Qué fecha y hora le convienen?');
  });
});
