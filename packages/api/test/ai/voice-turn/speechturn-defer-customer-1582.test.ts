/**
 * #1582 (owner decision 2026-10-02, follow-up to #1567) — a NEW caller whose
 * request is a booking, on a tenant with a configured service area, gets a
 * customer record only once the ZIP check passes. An out-of-area caller is
 * captured as a LEAD only. Unchanged: known customers, tenants with no
 * service area, non-booking requests (#1540 §2 creates the customer as soon
 * as the caller is identified).
 *
 * Seam: createVoiceTurnProcessor().speechTurn with a scripted gateway and
 * in-memory repos.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryCustomerRepository, createCustomer } from '../../../src/customers/customer';
import { InMemoryLeadRepository } from '../../../src/leads/in-memory-lead';
import { InMemorySettingsRepository, type TenantSettings } from '../../../src/settings/settings';
import type { LLMGateway, LLMRequest } from '../../../src/ai/gateway/gateway';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

const TENANT = 'tenant-1582-defer';
const CALL_SID = 'CA-1582-defer';
const NEW_CALLER = '+15555550582';
const LA_ZIPS = ['90001', '90002', '90012'];

/** #1577 — a booking with no day or time goes on to ask for one (the usual booking flow). */
const ASKS_FOR_TIME = 'What date and time work for you?';
const OUT_OF_AREA_LINE = "We don't usually service that area, but I'll pass your details to the team.";

const BOOKING = JSON.stringify({
  intentType: 'create_appointment',
  confidence: 0.93,
  extractedEntities: { jobReference: 'HVAC service' },
});

const UNCLEAR = JSON.stringify({ intentType: 'unknown', confidence: 0.2, extractedEntities: {} });

/** Classifies the caller's words: a booking ask → `classifier`, a bare ZIP answer → unknown. */
function scriptedGateway(classifier: string): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest) => {
      const isConfirm = (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent';
      const lastMessage = String(req.messages?.[req.messages.length - 1]?.content ?? '');
      const asksForService = /schedule|book|come out/i.test(lastMessage);
      return {
        content: isConfirm
          ? JSON.stringify({ answer: 'no', reasoning: 'scripted' })
          : asksForService
            ? classifier
            : UNCLEAR,
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

async function call(opts: { serviceAreaZips?: string[]; knownCustomer?: boolean; classifier?: string }) {
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const customerRepo = new InMemoryCustomerRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const leadRepo = new InMemoryLeadRepository();
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({
    tenantId: TENANT,
    timezone: 'America/Los_Angeles',
    ...(opts.serviceAreaZips ? { serviceAreaZips: opts.serviceAreaZips } : {}),
  } as unknown as TenantSettings);
  const session = store.create(TENANT, 'telephony', { callSid: CALL_SID });
  session.machine.dispatch({ type: 'incoming_call', callSid: CALL_SID, from: NEW_CALLER, to: '+15125550999', tenantId: TENANT });
  session.machine.dispatch({ type: 'greeted_ok' });
  if (opts.knownCustomer) {
    const known = await createCustomer(
      { tenantId: TENANT, firstName: 'Pat', lastName: 'Known', primaryPhone: NEW_CALLER, createdBy: 'test' },
      customerRepo,
    );
    session.customerId = known.id;
    session.machine.dispatch({ type: 'caller_known', customerId: known.id });
  } else {
    session.machine.dispatch({ type: 'unknown_caller' });
  }
  session.callerPhone = NEW_CALLER;
  const processor = createVoiceTurnProcessor({
    store,
    gateway: scriptedGateway(opts.classifier ?? BOOKING),
    businessName: 'Test HVAC Co',
    systemActorId: 'test-actor',
    auditRepo: new InMemoryAuditRepository(),
    proposalRepo,
    customerRepo,
    leadRepo,
    settingsRepo,
  });
  const turn = async (speechResult: string) =>
    spoken(await processor.speechTurn({ session, speechResult, callSid: CALL_SID, tenantId: TENANT }));
  return { session, proposalRepo, leadRepo, customerRepo, turn };
}

describe('#1582 — the new caller\'s customer record waits for the service-area check', () => {
  it('an out-of-area booking caller is kept as a lead only — no customer record', async () => {
    const c = await call({ serviceAreaZips: LA_ZIPS });

    const reply = await c.turn("Hi, I'm in 30309 Atlanta and I'd like to schedule HVAC service.");

    expect(reply).toBe(OUT_OF_AREA_LINE);
    expect(await c.leadRepo.findByTenant(TENANT)).toHaveLength(1);
    expect(await c.customerRepo.findByTenant(TENANT)).toEqual([]);
  });

  it('a non-booking request still creates the caller\'s customer record right away (#1540 §2)', async () => {
    const c = await call({
      serviceAreaZips: LA_ZIPS,
      classifier: JSON.stringify({
        intentType: 'draft_estimate',
        confidence: 0.93,
        extractedEntities: { jobReference: 'new AC unit' },
      }),
    });

    await c.turn('Can someone come out and give me a quote on a new AC unit?');

    const customers = await c.customerRepo.findByTenant(TENANT);
    expect(customers).toHaveLength(1);
    expect(customers[0]!.primaryPhone).toBe(NEW_CALLER);
    expect(c.session.customerId).toBe(customers[0]!.id);
  });

  it('a lookup (answered before any booking gate) still creates the caller\'s record right away', async () => {
    const c = await call({
      serviceAreaZips: LA_ZIPS,
      classifier: JSON.stringify({
        intentType: 'lookup_appointments',
        confidence: 0.93,
        extractedEntities: {},
      }),
    });

    await c.turn('When are you scheduled to come out to my place?');

    const customers = await c.customerRepo.findByTenant(TENANT);
    expect(customers).toHaveLength(1);
    expect(c.session.customerId).toBe(customers[0]!.id);
  });

  it('an in-area booking creates the record once the ZIP checks out, and the booking carries it', async () => {
    const c = await call({ serviceAreaZips: LA_ZIPS });

    await c.turn("Hi, I'd like to schedule HVAC service.");
    expect(await c.customerRepo.findByTenant(TENANT)).toEqual([]);

    const reply = await c.turn('It is 90012.');

    // The booking goes on as usual (no time given yet → #1577's time ask).
    expect(reply).toBe('What date and time work for you?');
    const customers = await c.customerRepo.findByTenant(TENANT);
    expect(customers).toHaveLength(1);
    expect(customers[0]!.primaryPhone).toBe(NEW_CALLER);
    expect(c.session.machine.currentContext.customerId).toBe(customers[0]!.id);
    expect(await c.leadRepo.findByTenant(TENANT)).toEqual([]);
  });

  it('an out-of-area answer to the ZIP question leaves a lead only', async () => {
    const c = await call({ serviceAreaZips: LA_ZIPS });

    await c.turn('Can somebody come out and book a furnace check?');
    const reply = await c.turn('three oh three oh nine');

    expect(reply).toBe(OUT_OF_AREA_LINE);
    expect(await c.leadRepo.findByTenant(TENANT)).toHaveLength(1);
    expect(await c.customerRepo.findByTenant(TENANT)).toEqual([]);
  });
});

describe('#1582 — unchanged where the hold does not apply', () => {
  it('a tenant with no service area creates the new caller\'s record as soon as they are identified', async () => {
    const c = await call({});

    await c.turn("Hi, I'm in 30309 Atlanta and I'd like to schedule HVAC service.");

    const customers = await c.customerRepo.findByTenant(TENANT);
    expect(customers).toHaveLength(1);
    expect(customers[0]!.primaryPhone).toBe(NEW_CALLER);
  });
});
