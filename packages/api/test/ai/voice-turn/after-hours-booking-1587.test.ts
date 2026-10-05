/**
 * #1587 — owner decision 2026-10-05 (amending D-040 §1): on an AI-answering
 * tenant an after-hours booking request BOOKS NORMALLY, exactly as during the
 * day. No after-hours `callback` proposal, nobody paged.
 *
 * The Layer 1 text-mode driver used to mint an after-hours callback itself (a
 * rule production never had), and D-040 §1 cited that corpus script as if it
 * described production. This pins the decided truth at the production seam:
 * `createVoiceTurnProcessor().speechTurn`, with a session established the way
 * the Twilio adapter establishes it and the tenant's clock at 10 pm on a
 * closed day. Expected values come from the decision, the #1577 rule (a
 * booking with no time asks for one) and `tts-copy.ts` — never from the
 * engine's internals.
 */
import { describe, it, expect } from 'vitest';
import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn/create-voice-turn-processor';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { LLMGateway, type LLMRequest, type LLMResponse } from '../../../src/ai/gateway/gateway';
import { InMemoryCustomerRepository, type Customer } from '../../../src/customers/customer';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryAppointmentRepository } from '../../../src/appointments/in-memory-appointment';
import { InMemoryOnCallRepository } from '../../../src/oncall/rotation';
import type { SettingsRepository, TenantSettings } from '../../../src/settings/settings';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

const TENANT = 't-1587-after-hours';
const JANE_ID = '00000000-0000-4000-8000-000000001588';
const JANE_PHONE = '+15555550501';
/** Monday 2026-05-04, 22:00 America/Los_Angeles — the corpus script's call moment. */
const TEN_PM_LOCAL = new Date('2026-05-04T22:00:00-07:00');

/**
 * Offline stand-in for the model calls a booking makes: the classifier (the
 * request, then the bare time the caller supplies to the readback) and the
 * readback's yes/no model (`confirmIntent`, same task type, its own prompt).
 */
class BookingGateway extends LLMGateway {
  constructor() {
    super({ defaultProvider: 'mock' }, new Map());
  }
  override async complete(request: LLMRequest): Promise<LLMResponse> {
    const user = request.messages.find((m) => m.role === 'user')?.content ?? '';
    let content: string;
    if (user.includes("Classify the caller's response as YES or NO")) {
      content = JSON.stringify({ answer: 'yes', reasoning: 'affirmative' });
    } else if (user.includes('Tuesday at 2pm')) {
      content = JSON.stringify({
        intentType: 'create_appointment',
        confidence: 0.95,
        extractedEntities: { dateTimeDescription: 'Tuesday at 2pm' },
      });
    } else {
      content = JSON.stringify({
        intentType: 'create_appointment',
        confidence: 0.95,
        extractedEntities: { jobTitle: 'AC service' },
      });
    }
    return {
      content,
      model: 'mock',
      provider: 'mock',
      latencyMs: 1,
      tokenUsage: { input: 10, output: 10, total: 20 },
    };
  }
}

function jane(): Customer {
  const now = new Date('2026-04-01T10:00:00.000Z');
  return {
    id: JANE_ID,
    tenantId: TENANT,
    firstName: 'Jane',
    lastName: 'Smith',
    displayName: 'Jane Smith',
    primaryPhone: JANE_PHONE,
    preferredChannel: 'phone',
    smsConsent: false,
    isArchived: false,
    createdBy: 'seed',
    createdAt: now,
    updatedAt: now,
  };
}

/** Mon–Fri 09:00–17:00 Pacific — the tenant is closed at the call moment. */
function settingsRepo(): SettingsRepository {
  const row = {
    tenantId: TENANT,
    timezone: 'America/Los_Angeles',
    businessHoursSchedule: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
      dayOfWeek,
      openTime: '09:00',
      closeTime: '17:00',
    })),
  } as unknown as TenantSettings;
  return {
    findByTenant: async (t: string) => (t === TENANT ? row : null),
  } as unknown as SettingsRepository;
}

async function makeHarness() {
  const store = new VoiceSessionStore({ startInterval: false });
  const customerRepo = new InMemoryCustomerRepository();
  await customerRepo.create(jane());
  const proposalRepo = new InMemoryProposalRepository();
  const processor = createVoiceTurnProcessor({
    store,
    gateway: new BookingGateway(),
    businessName: 'Acme HVAC',
    coverageSurface: 'gather',
    systemActorId: 'system:test',
    customerRepo,
    proposalRepo,
    auditRepo: new InMemoryAuditRepository(),
    appointmentRepo: new InMemoryAppointmentRepository(),
    onCallRepo: new InMemoryOnCallRepository(
      new Map([[TENANT, [{ id: 'oncall_1', userId: 'dispatcher_1', orderIndex: 0 }]]]),
    ),
    settingsRepo: settingsRepo(),
    now: () => TEN_PM_LOCAL,
    callerPhoneResolver: (s) => s.callerPhone ?? '',
  });
  const callSid = 'CA-1587-ah';
  const session = store.create(TENANT, 'telephony', { callSid, customerProtectionIntents: true });
  session.callerPhone = JANE_PHONE;
  const events: Array<Record<string, unknown>> = [];
  session.events.on('voice-event', (e: Record<string, unknown>) => events.push(e));
  session.machine.dispatch({ type: 'incoming_call', callSid, from: JANE_PHONE, to: '', tenantId: TENANT });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.customerId = JANE_ID;
  session.machine.dispatch({ type: 'caller_known', customerId: JANE_ID });
  const turn = (speech: string): Promise<SideEffect[]> =>
    processor.speechTurn({ session, speechResult: speech, callSid, tenantId: TENANT });
  const spoken = (fx: SideEffect[]): string =>
    fx
      .filter((f) => f.type === 'tts_play' && typeof f.payload.text === 'string')
      .map((f) => f.payload.text as string)
      .join(' ');
  return { session, proposalRepo, events, turn, spoken };
}

describe('#1587 — an after-hours booking request on an AI-answering tenant books normally', () => {
  it('asks for a time (#1577), reads the request back, and drafts the appointment for approval — no callback, nobody paged', async () => {
    const h = await makeHarness();

    const ask = await h.turn("Hi, I'd like to book a service appointment for my AC.");
    // No time was given: the agent asks for one, exactly as during the day.
    expect(h.spoken(ask)).toContain('What date and time work for you?');
    expect(await h.proposalRepo.findByTenant(TENANT)).toHaveLength(0);

    const readback = await h.turn('Tuesday at 2pm.');
    expect(h.spoken(readback)).toContain('Is that right?');
    expect(await h.proposalRepo.findByTenant(TENANT)).toHaveLength(0);

    await h.turn("Yes, that's right.");

    const proposals = await h.proposalRepo.findByTenant(TENANT);
    expect(proposals.map((p) => p.proposalType)).toEqual(['create_appointment']);
    expect(proposals[0]!.status).not.toBe('executed');
    // The withdrawn D-040 §1 clause: no after-hours callback, and no page.
    expect(proposals.some((p) => p.proposalType === 'callback')).toBe(false);
    expect(h.events.filter((e) => e.type === 'escalation_triggered')).toHaveLength(0);
  });
});
