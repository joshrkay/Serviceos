/**
 * #1587 / D-040 §1 — after hours, a caller's booking request becomes a
 * `callback` proposal for the morning instead of a live draft.
 *
 * D-040 (owner decision 2026-10-04) ratified this as the AI line's after-hours
 * behaviour and cited the Layer 1 script `05-compliance-edges/after-hours-
 * callback` as its evidence — but the rule lived only in the Layer 1 text-mode
 * driver, which minted the callback itself. This ports it into the production
 * turn engine so every transport that dispatches `speechTurn` reaches it.
 *
 * Seam: `createVoiceTurnProcessor().speechTurn` with a session established
 * the way the Twilio adapter establishes it. Expected values come from the
 * decision (a `callback` proposal, nothing booked), the payload contract
 * (`reason`, `transcript`) and `tts-copy.ts` — never from the engine's
 * internals.
 */
import { describe, it, expect } from 'vitest';
import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn/create-voice-turn-processor';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { LLMGateway, type LLMRequest, type LLMResponse } from '../../../src/ai/gateway/gateway';
import { InMemoryCustomerRepository, type Customer } from '../../../src/customers/customer';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryAppointmentRepository } from '../../../src/appointments/in-memory-appointment';
import type { SettingsRepository, TenantSettings } from '../../../src/settings/settings';
import { AFTER_HOURS_CALLBACK_COPY } from '../../../src/ai/agents/customer-calling/tts-copy';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

const TENANT = 't-1587-after-hours';
const JANE_ID = '00000000-0000-4000-8000-000000001588';
const JANE_PHONE = '+15555550501';
/** Monday 2026-05-04, 22:00 America/Los_Angeles — the corpus script's call moment. */
const TEN_PM_LOCAL = new Date('2026-05-04T22:00:00-07:00');
/** The same Monday at 14:00 local — inside the 09:00–17:00 schedule. */
const TWO_PM_LOCAL = new Date('2026-05-04T14:00:00-07:00');

class ClassifyGateway extends LLMGateway {
  constructor(private readonly content: Record<string, unknown>) {
    super({ defaultProvider: 'mock' }, new Map());
  }
  override async complete(_request: LLMRequest): Promise<LLMResponse> {
    return {
      content: JSON.stringify(this.content),
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

/** Mon–Fri 09:00–17:00 Pacific, as the onboarding Call Routing sheet stores it. */
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

async function makeHarness(now: Date) {
  const store = new VoiceSessionStore({ startInterval: false });
  const customerRepo = new InMemoryCustomerRepository();
  await customerRepo.create(jane());
  const proposalRepo = new InMemoryProposalRepository();
  const processor = createVoiceTurnProcessor({
    store,
    gateway: new ClassifyGateway({
      intentType: 'create_appointment',
      confidence: 0.95,
      extractedEntities: { jobTitle: 'AC service' },
    }),
    businessName: 'Acme HVAC',
    coverageSurface: 'gather',
    systemActorId: 'system:test',
    customerRepo,
    proposalRepo,
    auditRepo: new InMemoryAuditRepository(),
    appointmentRepo: new InMemoryAppointmentRepository(),
    settingsRepo: settingsRepo(),
    now: () => now,
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

describe('#1587 / D-040 — an after-hours booking request on the AI line', () => {
  it('becomes a callback proposal for the morning: nothing is read back or booked, nobody is paged', async () => {
    const h = await makeHarness(TEN_PM_LOCAL);

    const fx = await h.turn("Hi, I'd like to book a service appointment for my AC.");

    const proposals = await h.proposalRepo.findByTenant(TENANT);
    expect(proposals.map((p) => p.proposalType)).toEqual(['callback']);
    expect(proposals[0]!.payload).toMatchObject({
      reason: 'after_hours',
      transcript: "Hi, I'd like to book a service appointment for my AC.",
    });
    expect(proposals[0]!.status).not.toBe('executed');
    expect(h.spoken(fx)).toBe(AFTER_HOURS_CALLBACK_COPY);
    // Minted on the request turn — no readback, and the next turn can be a new request.
    expect(h.session.machine.currentState).toBe('intent_capture');
    expect(h.events.filter((e) => e.type === 'escalation_triggered')).toHaveLength(0);
  });

  it('during business hours the same request takes the normal readback path', async () => {
    const h = await makeHarness(TWO_PM_LOCAL);

    const fx = await h.turn("Hi, I'd like to book a service appointment for my AC.");

    expect(await h.proposalRepo.findByTenant(TENANT)).toHaveLength(0);
    expect(h.spoken(fx)).not.toBe(AFTER_HOURS_CALLBACK_COPY);
    expect(h.session.machine.currentState).toBe('intent_confirm');
  });
});
