/**
 * #1331 (owner decision 2026-10-01) — the caller-name identity check on the
 * PSTN/Gather transport too (the processor's shared `handleCallerIdentityCheck`,
 * same rule as media streams' speechTurn): a mumbled name on a caller-ID line
 * asks "is this Maria Rodriguez?" before anything acts on the account; yes →
 * the held request is handled; no → the account is unbound.
 *
 * Seam: TwilioGatherAdapter.handleGather with a scripted gateway and
 * in-memory repos (the gather-ask-caller-carries-request-1540 harness).
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryCustomerRepository, createCustomer } from '../../src/customers/customer';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';

const TENANT = 't-1331-gather-identity';
const CALLER_PHONE = '+15555550805';

function scriptedGateway(classifier: string): LLMGateway & { complete: ReturnType<typeof vi.fn> } {
  return {
    complete: vi.fn(
      async () =>
        ({
          content: classifier,
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway & { complete: ReturnType<typeof vi.fn> };
}

async function knownCallerGatherCall(callSid: string) {
  const store = new VoiceSessionStore({ startInterval: false });
  const customerRepo = new InMemoryCustomerRepository();
  const maria = await createCustomer(
    { tenantId: TENANT, firstName: 'Maria', lastName: 'Rodriguez', primaryPhone: CALLER_PHONE, createdBy: 'seed' },
    customerRepo,
  );
  const gateway = scriptedGateway(
    JSON.stringify({ intentType: 'create_appointment', confidence: 0.92, extractedEntities: { jobReference: 'furnace' } }),
  );
  const adapter = new TwilioGatherAdapter({
    store,
    gateway,
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    auditRepo: new InMemoryAuditRepository(),
    proposalRepo: new InMemoryProposalRepository(),
    customerRepo,
  });
  await adapter.handleInbound({ callSid, from: CALLER_PHONE, to: '+15125550000', tenantId: TENANT });
  const session = store.findByCallSid(callSid)!;
  // Caller-ID matched Maria (no Pool here, so the match is applied directly).
  session.machine.dispatch({ type: 'caller_known', customerId: maria.id });
  session.customerId = maria.id;
  const gather = (speechResult: string) =>
    adapter.handleGather({ sessionId: session.id, callSid, speechResult, confidence: 0.9, tenantId: TENANT });
  return { session, gateway, gather, maria };
}

describe('#1331 — Gather: a low-confidence caller name gets the yes/no identity check', () => {
  it('a mumbled name asks "is this Maria Rodriguez?" without classifying', async () => {
    const call = await knownCallerGatherCall('CA-1331-g1');

    const twiml = await call.gather('Hi this is Mmmmaria Roddrrgez, I need my furnace looked at');

    expect(twiml).toMatch(/is this Maria Rodriguez\?/);
    expect(call.gateway.complete).not.toHaveBeenCalled();
  });

  it('"yes" handles the held request on the account', async () => {
    const call = await knownCallerGatherCall('CA-1331-g2');
    await call.gather('Hi this is Mmmmaria Roddrrgez, I need my furnace looked at');

    const twiml = await call.gather('Yes.');

    expect(call.gateway.complete).toHaveBeenCalled();
    expect(call.session.machine.currentState).toBe('intent_confirm');
    // #1577 — the held booking has no time yet: the agent asks for one.
    expect(twiml).toContain('What date and time work for you?');
    expect(call.session.customerId).toBe(call.maria.id);
  });

  it('"no" unbinds the account and asks who it is speaking with', async () => {
    const call = await knownCallerGatherCall('CA-1331-g3');
    await call.gather('Hi this is Mmmmaria Roddrrgez, I need my furnace looked at');

    const twiml = await call.gather('No.');

    expect(twiml).toMatch(/Who am I speaking with/);
    expect(call.session.customerId).toBeUndefined();
    expect(call.session.machine.currentContext.customerId).toBeUndefined();
  });
});
