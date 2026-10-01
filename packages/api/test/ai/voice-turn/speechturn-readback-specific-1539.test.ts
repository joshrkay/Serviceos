/**
 * #1539 — the phone write readback must say WHAT will be drafted ("apply a
 * $50 credit for Dana Reyes"), not "take care of that request". One builder
 * (tts-copy.ts → intent-readback.ts) feeds the transcript line speechTurn
 * records AND the line the transports actually speak (they re-render the
 * payload through `renderTtsText`), so the two can never diverge again.
 *
 * Seam: speechTurn on the OWNER line (operator intents are on-surface there)
 * with a scripted classifier + confirm_intent and in-memory repos — the
 * #1331 owner-line harness. Expected lines are the spec, written by hand.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryCustomerRepository, createCustomer } from '../../../src/customers/customer';
import { renderTtsText } from '../../../src/ai/agents/customer-calling/tts-copy';
import type { LLMGateway, LLMRequest } from '../../../src/ai/gateway/gateway';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

const TENANT = 'tenant-1539-phone';
const CALL_SID = 'CA-1539';
const CALLER_ID = '+15125550100';

function phoneGateway(classifier: string): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest) => {
      const isConfirm =
        (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent';
      return {
        content: isConfirm ? JSON.stringify({ answer: 'no', reasoning: 'scripted' }) : classifier,
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

async function makeOwnerCall(intentType: string, entities: Record<string, unknown>, language?: 'es') {
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
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
  const session = store.create(TENANT, 'telephony', { callSid: CALL_SID, ownerSession: true });
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
  session.actorUserId = 'vq-owner:tenant-1539-phone';
  if (language) session.language = language;
  const processor = createVoiceTurnProcessor({
    store,
    gateway: phoneGateway(JSON.stringify({ intentType, confidence: 0.95, extractedEntities: entities })),
    businessName: 'Acme Plumbing',
    systemActorId: 'test-actor',
    auditRepo: new InMemoryAuditRepository(),
    proposalRepo: new InMemoryProposalRepository(),
    customerRepo,
  });
  const turn = (speechResult: string) =>
    processor.speechTurn({ session, speechResult, callSid: CALL_SID, tenantId: TENANT });
  return { session, turn };
}

/**
 * The readback as BOTH consumers see it: the transcript line speechTurn
 * records (payload.text) and the line a transport speaks (re-rendered from
 * the payload, exactly as twilio-adapter / mediastream-adapter do).
 */
function readback(sideEffects: SideEffect[], lang: 'en' | 'es' = 'en'): { recorded: string; heard: string } {
  const fx = sideEffects.filter((e) => e.type === 'tts_play').pop();
  if (!fx) throw new Error('no tts_play');
  return {
    recorded: String(fx.payload.text),
    heard: renderTtsText(String(fx.payload.text), fx.payload, lang),
  };
}

async function readbackFor(
  intentType: string,
  entities: Record<string, unknown>,
  language?: 'es',
): Promise<{ recorded: string; heard: string }> {
  const { session, turn } = await makeOwnerCall(intentType, entities, language);
  const fx = await turn('scripted utterance');
  expect(session.machine.currentState).toBe('intent_confirm');
  return readback(fx, language ?? 'en');
}

function expectReadback(got: { recorded: string; heard: string }, expected: string): void {
  expect(got.recorded).toBe(expected);
  expect(got.heard).toBe(expected);
}

describe('#1539 — phone readback names what will be drafted', () => {
  describe('scheduling', () => {
    it('a booking names the customer and the time', async () => {
      expectReadback(
        await readbackFor('create_appointment', {
          customerName: 'Dana Reyes',
          dateTimeDescription: 'Tuesday at 2pm',
        }),
        "Just to confirm — you'd like to schedule an appointment for Dana Reyes, Tuesday at 2pm. Is that right?",
      );
    });

    it('a booking with no time says so instead of confirming a time it never heard', async () => {
      expectReadback(
        await readbackFor('create_appointment', { customerName: 'Dana Reyes' }),
        "Just to confirm — you'd like to schedule an appointment for Dana Reyes, with no day or time yet. Is that right?",
      );
    });
  });

  describe('money', () => {
    it.each([
      [
        'apply_credit',
        { amount: 5000, customerName: 'Dana Reyes' },
        "Just to confirm — you'd like to apply a $50 credit for Dana Reyes. Is that right?",
      ],
      [
        'record_refund',
        { amount: 10000, customerName: 'Dana Reyes', refundMethod: 'check' },
        "Just to confirm — you'd like to record a $100 refund for Dana Reyes, paid by check. Is that right?",
      ],
      [
        'record_payment',
        { amount: 20050, customerName: 'Dana Reyes', paymentMethod: 'cash' },
        "Just to confirm — you'd like to record a $200.50 payment from Dana Reyes, paid in cash. Is that right?",
      ],
      [
        'log_expense',
        { amount: 6000, expenseDescription: 'PEX fittings', vendor: 'Ferguson' },
        "Just to confirm — you'd like to log a $60 expense for PEX fittings from Ferguson. Is that right?",
      ],
      [
        'log_mileage',
        { mileageMiles: 32 },
        "Just to confirm — you'd like to log 32 miles. Is that right?",
      ],
    ])('%s names the amount and who it is for', async (intent, entities, expected) => {
      expectReadback(await readbackFor(intent, entities), expected);
    });
  });

  describe('invoices and estimates', () => {
    const DANA = { customerName: 'Dana Reyes' };
    it.each([
      [
        'create_invoice',
        { ...DANA, lineItemDescriptions: ['capacitor', 'labor'] },
        'draft an invoice for Dana Reyes: capacitor and labor',
      ],
      [
        'update_invoice',
        { ...DANA, lineItemDescriptions: ['a $90 contactor'] },
        'update the invoice for Dana Reyes with a $90 contactor',
      ],
      ['issue_invoice', DANA, 'issue the invoice for Dana Reyes'],
      ['send_invoice', { ...DANA, sendChannel: 'email' }, 'send the invoice for Dana Reyes by email'],
      ['batch_invoice', {}, 'invoice all your completed jobs'],
      ['send_payment_reminder', DANA, 'send a payment reminder to Dana Reyes'],
      ['apply_late_fee', { ...DANA, amount: 2500 }, 'add a $25 late fee to the invoice for Dana Reyes'],
      [
        'draft_estimate',
        { ...DANA, lineItemDescriptions: ['3-ton condenser'] },
        'put together an estimate for Dana Reyes: 3-ton condenser',
      ],
      [
        'update_estimate',
        { ...DANA, lineItemDescriptions: ['3-ton condenser'] },
        'update the estimate for Dana Reyes with 3-ton condenser',
      ],
      ['send_estimate', DANA, 'send the estimate for Dana Reyes'],
      ['send_estimate_nudge', DANA, 'send a follow-up on the estimate for Dana Reyes'],
    ])('%s names the document and the customer', async (intent, entities, phrase) => {
      expectReadback(
        await readbackFor(intent, entities),
        `Just to confirm — you'd like to ${phrase}. Is that right?`,
      );
    });
  });

  describe('customers and leads', () => {
    it.each([
      ['create_customer', { displayName: 'Maria Alvarez' }, 'add Maria Alvarez as a new customer'],
      [
        'update_customer',
        { customerName: 'Dana Reyes', updatedPhone: '480-555-0123', updatedEmail: 'dana@example.com' },
        "update Dana Reyes's phone number to 480-555-0123 and email to dana@example.com",
      ],
      [
        'add_service_location',
        { customerName: 'Dana Reyes', serviceAddress: '12 Lakeshore Drive' },
        'add 12 Lakeshore Drive as a service location for Dana Reyes',
      ],
      ['convert_lead', { leadReference: 'Greenfield' }, 'convert the Greenfield lead into a customer'],
      [
        'mark_lead_lost',
        { leadReference: 'Wagner', lostReason: 'went with a competitor' },
        'mark the Wagner lead as lost: went with a competitor',
      ],
    ])('%s names who and what changes', async (intent, entities, phrase) => {
      expectReadback(
        await readbackFor(intent, entities),
        `Just to confirm — you'd like to ${phrase}. Is that right?`,
      );
    });
  });

  describe('jobs, notes and time', () => {
    const DANA = { customerName: 'Dana Reyes' };
    it.each([
      ['create_job', { ...DANA, jobTitle: 'No AC' }, 'open a new job for Dana Reyes: No AC'],
      [
        'log_warranty_claim',
        { ...DANA, jobTitle: 'Warranty — water heater leaking' },
        'log a warranty claim for Dana Reyes: water heater leaking',
      ],
      ['add_note', { ...DANA, noteBody: 'wants morning visits' }, 'add a note for Dana Reyes: wants morning visits'],
      ['log_permit', { ...DANA, noteBody: 'PERMIT: 2024-1187 approved' }, 'log permit 2024-1187 approved for Dana Reyes'],
      ['log_time_entry', { durationMinutes: 90 }, 'log 1 hour 30 minutes of time'],
      [
        'schedule_inspection',
        { ...DANA, jobTitle: 'Inspection — rough-in', dateTimeDescription: 'Thursday' },
        'schedule a rough-in inspection for Dana Reyes, Thursday',
      ],
    ])('%s names the job and what is recorded', async (intent, entities, phrase) => {
      expectReadback(
        await readbackFor(intent, entities),
        `Just to confirm — you'd like to ${phrase}. Is that right?`,
      );
    });
  });

  describe('messages to the customer', () => {
    const DANA = { customerName: 'Dana Reyes' };
    it.each([
      [
        'send_customer_message',
        { ...DANA, customerMessageBody: 'the part arrived, we can come Thursday' },
        'text Dana Reyes: the part arrived, we can come Thursday',
      ],
      [
        'send_customer_message',
        { ...DANA, customerMessageBody: 'your quote is attached', customerMessageChannel: 'email' },
        'email Dana Reyes: your quote is attached',
      ],
      ['request_feedback', DANA, 'ask Dana Reyes for a review'],
      ['notify_delay', { ...DANA, delayMinutes: 20 }, "let Dana Reyes know you're running 20 minutes late"],
    ])('%s names the recipient and the message', async (intent, entities, phrase) => {
      expectReadback(
        await readbackFor(intent, entities),
        `Just to confirm — you'd like to ${phrase}. Is that right?`,
      );
    });
  });

  describe('materials, price book, agreements and settings', () => {
    const DANA = { customerName: 'Dana Reyes' };
    it.each([
      [
        'add_material',
        { materialQuantity: 3, materialDescription: 'boxes of half-inch PEX', materialNeededBy: 'Friday' },
        'add boxes of half-inch PEX, quantity 3, to the shopping list, needed by Friday',
      ],
      [
        'add_catalog_item',
        { catalogItemNewName: 'smart thermostat install', unitPriceCents: 38500 },
        'add smart thermostat install to your price book at $385',
      ],
      [
        'update_catalog_item',
        { catalogItemReference: 'diagnostic fee', unitPriceCents: 8900 },
        'change the price of diagnostic fee to $89',
      ],
      [
        'create_change_order',
        { ...DANA, changeOrderDescription: 'a second zone', amount: 180000 },
        'create a change order for Dana Reyes: a second zone, for $1800',
      ],
      [
        'create_service_agreement',
        { ...DANA, serviceAgreementName: 'Gold maintenance plan', serviceAgreementCadence: 'twice_a_year' },
        'sign Dana Reyes up for the Gold maintenance plan, twice a year',
      ],
      [
        'create_invoice_schedule',
        { ...DANA, scheduleDescription: '50% deposit, 50% on completion' },
        'set up a payment schedule for Dana Reyes: 50% deposit, 50% on completion',
      ],
      [
        'respond_to_review',
        { reviewReference: 'the 1-star review from Tuesday' },
        'respond to the 1-star review from Tuesday',
      ],
      [
        'create_standing_instruction',
        { instructionText: 'always add a $79 diagnostic fee to AC calls' },
        'save a standing rule: always add a $79 diagnostic fee to AC calls',
      ],
      [
        'update_brand_voice',
        { brandVoiceInstruction: 'friendly, no slang' },
        'update your brand voice: friendly, no slang',
      ],
    ])('%s names the item and the terms', async (intent, entities, phrase) => {
      expectReadback(
        await readbackFor(intent, entities),
        `Just to confirm — you'd like to ${phrase}. Is that right?`,
      );
    });
  });

  describe('Spanish session', () => {
    const DANA = { customerName: 'Dana Reyes' };
    it.each([
      [
        'create_appointment',
        { ...DANA, dateTimeDescription: 'el martes a las 2' },
        'agendar una cita para Dana Reyes, el martes a las 2',
      ],
      ['apply_credit', { ...DANA, amount: 5000 }, 'aplicar un crédito de $50 para Dana Reyes'],
      [
        'send_invoice',
        { ...DANA, sendChannel: 'sms' },
        'enviar la factura de Dana Reyes por mensaje de texto',
      ],
      [
        'update_customer',
        { ...DANA, updatedPhone: '480-555-0123' },
        'actualizar el teléfono de Dana Reyes a 480-555-0123',
      ],
      ['log_time_entry', { durationMinutes: 90 }, 'registrar 1 hora 30 minutos de trabajo'],
      [
        'send_customer_message',
        { ...DANA, customerMessageBody: 'llegó la pieza' },
        'enviar un mensaje de texto a Dana Reyes: llegó la pieza',
      ],
      [
        'add_material',
        { materialQuantity: 3, materialDescription: 'cajas de PEX de media pulgada' },
        'agregar cajas de PEX de media pulgada, cantidad 3, a la lista de compras',
      ],
      [
        'reschedule_appointment',
        { appointmentReference: 'la cita del martes', newDateTimeDescription: 'el jueves a las 10' },
        'mover la cita del martes para el jueves a las 10',
      ],
    ])('%s reads back in Spanish', async (intent, entities, phrase) => {
      expectReadback(
        await readbackFor(intent, entities, 'es'),
        `Para confirmar: usted desea ${phrase}. ¿Es correcto?`,
      );
    });
  });

  describe('changes to an existing appointment', () => {
    const GARCIA = { appointmentReference: "Tuesday's Garcia appointment" };
    it.each([
      [
        'reschedule_appointment',
        { ...GARCIA, newDateTimeDescription: 'Thursday at 10' },
        "move Tuesday's Garcia appointment to Thursday at 10",
      ],
      ['cancel_appointment', GARCIA, "cancel Tuesday's Garcia appointment"],
      ['confirm_appointment', GARCIA, "confirm Tuesday's Garcia appointment"],
      [
        'reassign_appointment',
        { ...GARCIA, targetTechnicianName: 'Carlos' },
        "put Carlos on Tuesday's Garcia appointment",
      ],
      [
        'add_crew_member',
        { ...GARCIA, targetTechnicianName: 'Carlos' },
        "add Carlos to Tuesday's Garcia appointment",
      ],
      [
        'remove_crew_member',
        { ...GARCIA, targetTechnicianName: 'Carlos' },
        "take Carlos off Tuesday's Garcia appointment",
      ],
    ])('%s names the appointment and the change', async (intent, entities, phrase) => {
      expectReadback(
        await readbackFor(intent, entities),
        `Just to confirm — you'd like to ${phrase}. Is that right?`,
      );
    });
  });
});
