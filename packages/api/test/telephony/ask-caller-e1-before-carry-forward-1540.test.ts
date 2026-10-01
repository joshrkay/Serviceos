/**
 * #1540 §2 × life safety — the unknown-caller identify + carry-forward turn
 * classifies the caller's request. The deterministic E1 safety scan MUST
 * still run first on that turn: an unknown caller whose FIRST utterance is a
 * gas leak (even one that also asks for a booking) takes the life-safety
 * terminal path with NO model call, no classification, no caller record
 * minted mid-emergency and no booking drafted.
 *
 * Seams: TwilioGatherAdapter.handleGather (Gather) and
 * TwilioGatherAdapter.processCallerUtterance (the media-streams entry that
 * delegates to the processor's speechTurn), each with a scripted gateway that
 * would happily classify a booking if it were ever asked.
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import type { SideEffect } from '../../src/ai/agents/customer-calling/types';

const TENANT = 't-1540-e1';
const FIRST_UTTERANCE = 'I need an appointment tomorrow at 9am — and I smell gas in my kitchen, it is getting stronger';

function harness(callSid: string) {
  const store = new VoiceSessionStore({ startInterval: false });
  const customerRepo = new InMemoryCustomerRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const llm = vi.fn(async (req: { taskType?: string; metadata?: { skill?: string } }) => ({
    content:
      req.metadata?.skill === 'confirm_intent'
        ? JSON.stringify({ answer: 'yes', reasoning: 'scripted' })
        : JSON.stringify({
            intentType: 'create_appointment',
            confidence: 0.95,
            extractedEntities: { dateTimeDescription: 'tomorrow at 9am' },
          }),
    model: 'mock',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  }));
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: { complete: llm },
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    auditRepo: new InMemoryAuditRepository(),
    proposalRepo,
    customerRepo,
  } as never);
  return {
    store,
    adapter,
    llm,
    customerRepo,
    proposalRepo,
    start: async () => {
      await adapter.handleInbound({ callSid, from: '+15125558800', to: '+15125550000', tenantId: TENANT });
      const session = store.findByCallSid(callSid)!;
      expect(session.machine.currentState).toBe('ask_caller');
      return session;
    },
  };
}

function nonSummaryModelCalls(llm: ReturnType<typeof harness>['llm']): number {
  return llm.mock.calls.filter(([req]) => req?.taskType !== 'summarize_conversation').length;
}

describe('#1540 §2 — E1 runs before the unknown-caller carry-forward classification', () => {
  it('Gather: a gas leak in the FIRST utterance terminates on the life-safety path with no model call and nothing drafted', async () => {
    const h = harness('CA-1540-e1-g');
    const session = await h.start();

    const twiml = await h.adapter.handleGather({
      sessionId: session.id,
      callSid: 'CA-1540-e1-g',
      speechResult: FIRST_UTTERANCE,
      confidence: 0.95,
      tenantId: TENANT,
    });

    expect(session.machine.currentContext.escalationReason).toBe('life_safety_e1');
    expect(twiml).toContain('911');
    expect(nonSummaryModelCalls(h.llm)).toBe(0);
    expect(await h.proposalRepo.findByTenant(TENANT)).toEqual([]);
    expect(await h.customerRepo.findByTenant(TENANT)).toEqual([]);
  });

  it('media-streams: the same first utterance takes the life-safety path with no model call and nothing drafted', async () => {
    const h = harness('CA-1540-e1-ms');
    const session = await h.start();

    const fx: SideEffect[] = await h.adapter.processCallerUtterance({
      sessionId: session.id,
      callSid: 'CA-1540-e1-ms',
      speechResult: FIRST_UTTERANCE,
      tenantId: TENANT,
    });

    expect(session.machine.currentContext.escalationReason).toBe('life_safety_e1');
    expect(fx.some((f) => f.type === 'tts_play' && String(f.payload.text).includes('911'))).toBe(true);
    expect(nonSummaryModelCalls(h.llm)).toBe(0);
    expect(await h.proposalRepo.findByTenant(TENANT)).toEqual([]);
    expect(await h.customerRepo.findByTenant(TENANT)).toEqual([]);
  });
});
