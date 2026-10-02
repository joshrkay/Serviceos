/**
 * #1567 (owner decisions 2026-10-02) — the PSTN/Gather path runs the same
 * service-area gate as media-streams: a new caller booking outside the
 * tenant's ZIPs is told so, kept as a lead, and nothing is drafted; a new
 * caller who gives no ZIP is asked for it and an in-area answer books as usual.
 *
 * Seam: TwilioGatherAdapter.handleGather with a scripted gateway and
 * in-memory repos.
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMRequest } from '../../src/ai/gateway/gateway';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryLeadRepository } from '../../src/leads/in-memory-lead';
import { InMemorySettingsRepository, type TenantSettings } from '../../src/settings/settings';

const TENANT = 't-1567-gather';
const CALLER_PHONE = '+15555550568';

function scriptedGateway(): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest) => {
      const isConfirm = (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent';
      const last = String(req.messages?.[req.messages.length - 1]?.content ?? '');
      const content = isConfirm
        ? JSON.stringify({ answer: 'no', reasoning: 'scripted' })
        : /schedule/i.test(last)
          ? JSON.stringify({ intentType: 'create_appointment', confidence: 0.93, extractedEntities: { jobReference: 'HVAC service' } })
          : JSON.stringify({ intentType: 'unknown', confidence: 0.2, extractedEntities: {} });
      return { content, model: 'mock', provider: 'mock', tokenUsage: { input: 1, output: 1, total: 2 }, latencyMs: 1 };
    }),
  } as unknown as LLMGateway;
}

async function gatherCall(callSid: string) {
  const store = new VoiceSessionStore({ startInterval: false });
  const leadRepo = new InMemoryLeadRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const settingsRepo = new InMemorySettingsRepository();
  const auditRepo = new InMemoryAuditRepository();
  await settingsRepo.create({ tenantId: TENANT, timezone: 'America/Los_Angeles', serviceAreaZips: ['90001', '90012'] } as unknown as TenantSettings);
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: scriptedGateway(),
    businessName: 'Acme HVAC',
    publicBaseUrl: 'https://example.com',
    auditRepo,
    proposalRepo,
    customerRepo: new InMemoryCustomerRepository(),
    leadRepo,
    settingsRepo,
  });
  await adapter.handleInbound({ callSid, from: CALLER_PHONE, to: '+15125550000', tenantId: TENANT });
  const session = store.findByCallSid(callSid)!;
  const say = (speechResult: string) =>
    adapter.handleGather({ sessionId: session.id, callSid, speechResult, confidence: 0.9, tenantId: TENANT });
  return { session, leadRepo, proposalRepo, auditRepo, say };
}

describe('#1567 — Gather: service area on a new caller\'s booking', () => {
  it('out-of-area ZIP → the out-of-area line, a lead with the ZIP, no appointment drafted', async () => {
    const c = await gatherCall('CA-1567-g1');

    const twiml = await c.say("Hi, I'm in 30309 Atlanta and I'd like to schedule HVAC service.");

    expect(twiml).toContain('We don&apos;t usually service that area, but I&apos;ll pass your details to the team.');
    const leads = await c.leadRepo.findByTenant(TENANT);
    expect(leads).toHaveLength(1);
    // Gather captured the unknown caller as a lead at the start of the call;
    // the out-of-area ZIP is recorded against that lead.
    const outOfArea = c.auditRepo.getAll().filter((e) => e.eventType === 'voice.out_of_service_area');
    expect(outOfArea).toHaveLength(1);
    expect(outOfArea[0]!.entityId).toBe(leads[0]!.id);
    expect(outOfArea[0]!.metadata).toMatchObject({ zip: '30309' });
    expect(await c.proposalRepo.findByTenant(TENANT)).toEqual([]);
    expect(c.session.machine.currentState).not.toBe('intent_confirm');
  });

  it('no ZIP → asked for it; an in-area answer goes on to the readback', async () => {
    const c = await gatherCall('CA-1567-g2');

    const ask = await c.say("Hi, I'd like to schedule HVAC service.");
    expect(ask).toContain('ZIP code for the address where you need the service?');

    const twiml = await c.say('nine zero zero one two');
    expect(twiml).toContain('Just to confirm');
  });
});
