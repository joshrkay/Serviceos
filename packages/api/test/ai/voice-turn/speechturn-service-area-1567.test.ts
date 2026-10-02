/**
 * #1567 (owner decisions 2026-10-02) — inbound phone booking honours the
 * tenant's service area.
 *  1. A NEW caller booking outside the area is told so ("We don't usually
 *     service that area, but I'll pass your details to the team."), kept as a
 *     LEAD, and no appointment is drafted.
 *  2. A new caller on a booking is asked for the service-address ZIP, which
 *     is checked with checkServiceArea against the tenant's ZIP list.
 *  3. A tenant with no service area configured gets no check and no question.
 * Existing (known) customers are unchanged.
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

const TENANT = 'tenant-1567-area';
const CALL_SID = 'CA-1567-area';
const NEW_CALLER = '+15555550567';
const LA_ZIPS = ['90001', '90002', '90012'];

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
  return { session, proposalRepo, leadRepo, turn };
}

describe('#1567 — new caller booking outside the tenant service area', () => {
  it('says so, keeps them as a lead, and drafts no appointment when they give an out-of-area ZIP', async () => {
    const c = await call({ serviceAreaZips: LA_ZIPS });

    const reply = await c.turn("Hi, I'm in 30309 Atlanta and I'd like to schedule HVAC service.");

    expect(reply).toBe(OUT_OF_AREA_LINE);
    const leads = await c.leadRepo.findByTenant(TENANT);
    expect(leads).toHaveLength(1);
    expect(leads[0]!.primaryPhone).toBe(NEW_CALLER);
    expect(leads[0]!.notes).toContain('30309');
    expect(await c.proposalRepo.findByTenant(TENANT)).toEqual([]);
    expect(c.session.machine.currentState).not.toBe('intent_confirm');
  });

  it('asks a new caller for the service-address ZIP, then books as usual when it is in the area', async () => {
    const c = await call({ serviceAreaZips: LA_ZIPS });

    const ask = await c.turn("Hi, I'd like to schedule HVAC service.");
    expect(ask).toBe("Sure — what's the ZIP code for the address where you need the service?");
    expect(c.session.machine.currentState).not.toBe('intent_confirm');

    const reply = await c.turn('It is 90012.');
    expect(reply).toMatch(/^Just to confirm — you'd like to schedule an appointment/);
    expect(await c.leadRepo.findByTenant(TENANT)).toEqual([]);
  });

  it('declines and keeps a lead when the ZIP given in answer is out of the area (spoken digit by digit)', async () => {
    const c = await call({ serviceAreaZips: LA_ZIPS });

    await c.turn('Can somebody come out and book a furnace check?');
    const reply = await c.turn('three oh three oh nine');

    expect(reply).toBe(OUT_OF_AREA_LINE);
    const leads = await c.leadRepo.findByTenant(TENANT);
    expect(leads).toHaveLength(1);
    expect(leads[0]!.notes).toContain('30309');
    expect(await c.proposalRepo.findByTenant(TENANT)).toEqual([]);
  });

  it('re-asks once, then lets the booking go ahead when the caller still gives no ZIP', async () => {
    const c = await call({ serviceAreaZips: LA_ZIPS });

    await c.turn("Hi, I'd like to schedule HVAC service.");
    expect(await c.turn("I'm not sure")).toBe(
      "Sure — what's the ZIP code for the address where you need the service?",
    );
    const reply = await c.turn('no idea, sorry');

    expect(reply).toMatch(/^Just to confirm — you'd like to schedule an appointment/);
    expect(await c.leadRepo.findByTenant(TENANT)).toEqual([]);
  });
});

describe('#1567 — where the service-area check does not apply', () => {
  it('a tenant with no service area configured gets no ZIP question and no check', async () => {
    const c = await call({});

    const reply = await c.turn("Hi, I'm in 30309 Atlanta and I'd like to schedule HVAC service.");

    expect(reply).toMatch(/^Just to confirm — you'd like to schedule an appointment/);
    expect(await c.leadRepo.findByTenant(TENANT)).toEqual([]);
  });

  it('an existing customer booking is unchanged — no ZIP question, no decline', async () => {
    const c = await call({ serviceAreaZips: LA_ZIPS, knownCustomer: true });

    const reply = await c.turn("I'm in 30309 now and I'd like to schedule HVAC service.");

    expect(reply).toMatch(/^Just to confirm — you'd like to schedule an appointment/);
    expect(await c.leadRepo.findByTenant(TENANT)).toEqual([]);
  });
});
