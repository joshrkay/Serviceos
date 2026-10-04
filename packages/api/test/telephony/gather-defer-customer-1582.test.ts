/**
 * #1582 (owner decision 2026-10-02, follow-up to #1567) — on the PSTN/Gather
 * path too, a NEW caller on a tenant with a service area gets a customer
 * record only once it is known their request is not an out-of-area booking.
 * An out-of-area booking caller is a lead only; a non-booking request (here a
 * lookup) still creates the record right away (#1540 §2).
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

const TENANT = 't-1582-gather';
const CALLER_PHONE = '+15555550583';

function scriptedGateway(): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest) => {
      const isConfirm = (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent';
      const last = String(req.messages?.[req.messages.length - 1]?.content ?? '');
      const content = isConfirm
        ? JSON.stringify({ answer: 'no', reasoning: 'scripted' })
        : /schedule/i.test(last)
          ? JSON.stringify({ intentType: 'create_appointment', confidence: 0.93, extractedEntities: { jobReference: 'HVAC service' } })
          : /when are you/i.test(last)
            ? JSON.stringify({ intentType: 'lookup_appointments', confidence: 0.93, extractedEntities: {} })
            : JSON.stringify({ intentType: 'unknown', confidence: 0.2, extractedEntities: {} });
      return { content, model: 'mock', provider: 'mock', tokenUsage: { input: 1, output: 1, total: 2 }, latencyMs: 1 };
    }),
  } as unknown as LLMGateway;
}

async function gatherCall(callSid: string) {
  const store = new VoiceSessionStore({ startInterval: false });
  const leadRepo = new InMemoryLeadRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({ tenantId: TENANT, timezone: 'America/Los_Angeles', serviceAreaZips: ['90001', '90012'] } as unknown as TenantSettings);
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: scriptedGateway(),
    businessName: 'Acme HVAC',
    publicBaseUrl: 'https://example.com',
    auditRepo: new InMemoryAuditRepository(),
    proposalRepo: new InMemoryProposalRepository(),
    customerRepo,
    leadRepo,
    settingsRepo,
  });
  await adapter.handleInbound({ callSid, from: CALLER_PHONE, to: '+15125550000', tenantId: TENANT });
  const session = store.findByCallSid(callSid)!;
  const say = (speechResult: string) =>
    adapter.handleGather({ sessionId: session.id, callSid, speechResult, confidence: 0.9, tenantId: TENANT });
  return { session, leadRepo, customerRepo, say };
}

describe('#1582 — Gather: the new caller\'s customer record waits for the service-area check', () => {
  it('an out-of-area booking caller is a lead only — no customer record', async () => {
    const c = await gatherCall('CA-1582-g1');

    const twiml = await c.say("Hi, I'm in 30309 Atlanta and I'd like to schedule HVAC service.");

    expect(twiml).toContain('We don&apos;t usually service that area');
    expect(await c.leadRepo.findByTenant(TENANT)).toHaveLength(1);
    expect(await c.customerRepo.findByTenant(TENANT)).toEqual([]);
  });

  it('a non-booking request (a lookup) still creates the caller\'s record right away', async () => {
    const c = await gatherCall('CA-1582-g2');

    await c.say('When are you coming out to my place?');

    const customers = await c.customerRepo.findByTenant(TENANT);
    expect(customers).toHaveLength(1);
    expect(customers[0]!.primaryPhone).toBe(CALLER_PHONE);
    expect(c.session.customerId).toBe(customers[0]!.id);
  });
});
