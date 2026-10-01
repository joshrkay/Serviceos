/**
 * #1538 — the Twilio GATHER transport (TwilioGatherAdapter.handleGather) has
 * its own intent_confirm branch. A detail given at the readback ("Tuesday at
 * 2pm") must merge into the pending booking and be read back again there too
 * — the SAME shared rule speechTurn runs — instead of a correction that
 * throws the booking away.
 *
 * Seam: handleGather (TwiML out) with a scripted gateway (classifier +
 * confirm_intent) and in-memory repos, as the #1476 Gather tests do.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryCustomerRepository, createCustomer } from '../../src/customers/customer';
import type { LLMGateway, LLMRequest } from '../../src/ai/gateway/gateway';

const TENANT = 'tenant-1538-gather';
const CALL_SID = 'CA-1538-gather';
const CALLER_ID = '+15125550100';

const TIME_ONLY = JSON.stringify({
  intentType: 'unknown',
  confidence: 0.4,
  extractedEntities: { dateTimeDescription: 'Tuesday at 2pm' },
});

/** confirm_intent says "yes" only to "Yes, that's right"; the classifier only knows the time. */
function gatherGateway(): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest) => {
      const isConfirm =
        (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent';
      const said = JSON.stringify(req.messages ?? '');
      return {
        content: isConfirm
          ? JSON.stringify({ answer: /Yes, that's right/.test(said) ? 'yes' : 'no', reasoning: 'scripted' })
          : said.includes('Tuesday at 2pm')
            ? TIME_ONLY
            : JSON.stringify({ intentType: 'unknown', confidence: 0.2, extractedEntities: {} }),
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

async function makeGatherCall() {
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
  const session = store.create(TENANT, 'telephony', { callSid: CALL_SID });
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

describe('#1538 — Gather: a detail given at the readback', () => {
  it('merges the detail into the pending booking, reads back again, and the yes drafts it', async () => {
    const { session, proposalRepo, gather } = await makeGatherCall();
    await gather('I want to book a service appointment.');
    expect(session.machine.currentState).toBe('intent_confirm');

    const twiml = await gather('Tuesday at 2pm.');
    expect(session.machine.currentState).toBe('intent_confirm');
    expect(twiml).not.toMatch(/let me try again/i);
    expect(twiml).toMatch(/Is that right\?/);
    expect(session.machine.currentContext.extractedEntities?.dateTimeDescription).toBe(
      'Tuesday at 2pm',
    );

    await gather("Yes, that's right.");
    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('create_appointment');
  });
});
