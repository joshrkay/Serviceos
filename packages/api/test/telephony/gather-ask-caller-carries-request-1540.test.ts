/**
 * #1540 §2 (owner decision 2026-10-01) — on the PSTN/Gather path too, the
 * unknown caller's ask_caller answer is identified by phone AND its request
 * is classified in the same turn, so the call goes straight to the readback
 * instead of "How can I help you today?".
 *
 * Seam: TwilioGatherAdapter.handleGather with a scripted gateway and
 * in-memory repos (the ask-caller-gather.test.ts harness).
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';

const TENANT = 't-1540-gather-ask';
const CALLER_PHONE = '+15125557790';

function scriptedGateway(classifier: string): LLMGateway {
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
  } as unknown as LLMGateway;
}

describe('#1540 §2 — Gather: the ask_caller turn carries the request forward', () => {
  it('"I\'d like to schedule service for my home" → caller created by phone AND read back, no "How can I help"', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const customerRepo = new InMemoryCustomerRepository();
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: scriptedGateway(
        JSON.stringify({
          intentType: 'create_appointment',
          confidence: 0.92,
          extractedEntities: { jobReference: 'home service' },
        }),
      ),
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://example.com',
      auditRepo: new InMemoryAuditRepository(),
      proposalRepo: new InMemoryProposalRepository(),
      customerRepo,
    });
    await adapter.handleInbound({ callSid: 'CA-1540-g', from: CALLER_PHONE, to: '+15125550000', tenantId: TENANT });
    const session = store.findByCallSid('CA-1540-g')!;
    expect(session.machine.currentState).toBe('ask_caller');

    const twiml = await adapter.handleGather({
      sessionId: session.id,
      callSid: 'CA-1540-g',
      speechResult: "Hi, I'd like to schedule service for my home.",
      confidence: 0.9,
      tenantId: TENANT,
    });

    expect(session.customerId).toBeTruthy();
    expect(session.machine.currentState).toBe('intent_confirm');
    expect(twiml).toContain('Just to confirm');
    expect(twiml).not.toContain('How can I help you today?');
  });
});
