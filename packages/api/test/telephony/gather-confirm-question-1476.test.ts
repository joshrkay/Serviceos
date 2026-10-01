/**
 * #1476 item 3 — the Twilio GATHER transport (TwilioGatherAdapter.handleGather)
 * has its own intent_confirm branch. A question asked at the yes/no readback
 * must be answered there too — pending request kept, readback re-asked —
 * with the SAME surface rules as speechTurn (one shared helper):
 *   - S1 caller: only a number given on this call, or their caller-ID masked;
 *   - owner line: the customer's number on file.
 *
 * Seam: handleGather (TwiML out) with a scripted gateway (classifier +
 * confirm_intent) and in-memory repos, as the twilio-adapter tests do.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryCustomerRepository, createCustomer } from '../../src/customers/customer';
import type { LLMGateway, LLMRequest } from '../../src/ai/gateway/gateway';

const TENANT = 'tenant-1476-gather';
const CALL_SID = 'CA-1476-gather';
const CALLER_ID = '+15125550100';

const BOOKING = JSON.stringify({
  intentType: 'create_appointment',
  confidence: 0.92,
  extractedEntities: {
    jobReference: 'furnace not heating',
    dateTimeDescription: 'Tuesday at 2pm',
  },
});

/** confirm_intent says "yes" only to the scripted "Yes, go ahead." turn. */
function gatherGateway(): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest) => {
      const isConfirm =
        (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent';
      const saidYes = JSON.stringify(req.messages ?? '').includes('Yes, go ahead');
      return {
        content: isConfirm
          ? JSON.stringify({ answer: saidYes ? 'yes' : 'no', reasoning: 'scripted' })
          : BOOKING,
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

async function makeGatherCall(opts: { ownerSession: boolean }) {
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const proposalRepo = new InMemoryProposalRepository();
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
  const session = store.create(TENANT, 'telephony', {
    callSid: CALL_SID,
    ...(opts.ownerSession ? { ownerSession: true } : {}),
  });
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
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: gatherGateway(),
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    auditRepo: new InMemoryAuditRepository(),
    proposalRepo,
    customerRepo,
  });
  const gather = (speechResult: string) =>
    adapter.handleGather({
      sessionId: session.id,
      callSid: CALL_SID,
      speechResult,
      confidence: 0.95,
      tenantId: TENANT,
    });
  return { session, proposalRepo, gather };
}

describe('#1476 — Gather: a question during the confirm step', () => {
  it('S1 caller: the callback-number question reads back their caller-ID masked — never the record — and keeps the booking', async () => {
    const { session, proposalRepo, gather } = await makeGatherCall({ ownerSession: false });
    await gather('Can someone come out Tuesday at 2pm? My furnace is not heating.');
    expect(session.machine.currentState).toBe('intent_confirm');

    const twiml = await gather('Can you confirm the number you have for me to call back?');
    expect(session.machine.currentState).toBe('intent_confirm');
    expect(twiml).toMatch(/ending in 0100/);
    expect(twiml).not.toMatch(/0199/);
    expect(twiml).not.toMatch(/let me try again/i);
    expect(twiml).toMatch(/Is that right\?/);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);

    await gather('Yes, go ahead.');
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(1);
  });

  it('owner line: the callback-number question reads back the customer number on file', async () => {
    const { session, gather } = await makeGatherCall({ ownerSession: true });
    await gather('Can someone come out Tuesday at 2pm? My furnace is not heating.');

    const twiml = await gather('What number do you have to call them back?');
    expect(session.machine.currentState).toBe('intent_confirm');
    expect(twiml).toMatch(/480-555-0199/);
    expect(twiml).toMatch(/Is that right\?/);
  });
});
