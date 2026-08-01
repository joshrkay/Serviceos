/**
 * ask_caller on the Twilio Gather/PSTN path.
 *
 * An unknown caller (no caller-ID match — no Pool wired) lands in the FSM
 * `ask_caller` state. Before the fix the Gather adapter had NO handler for
 * ask_caller: every utterance fell through to the generic `else` →
 * `confidence_low`, which `ask_caller` ignores (ignoredTransition), so the
 * caller looped forever on a bare <Gather> reprompt and never reached intent
 * capture. The media-streams adapter already ran the find-or-create-customer
 * handler; this pins that the SAME shared handler (processor.handleAskCaller)
 * now runs on the Gather path so the caller advances to intake.
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryCustomerRepository } from '../../src/customers/customer';

const TENANT = 't-ask-caller';
const CALLER_PHONE = '+15125557788';

function makeGateway(content: string): LLMGateway {
  return {
    complete: vi.fn(
      async () =>
        ({
          content,
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

function makeHarness(opts: { withCustomerRepo?: boolean } = {}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const customerRepo = new InMemoryCustomerRepository();
  const auditRepo = new InMemoryAuditRepository();
  // The classify gateway is never reached on the ask_caller turn (find-or-
  // create runs first), but the adapter requires one.
  const gateway = makeGateway('{"intentType":"unknown","confidence":0,"reasoning":"x"}');
  const adapter = new TwilioGatherAdapter({
    store,
    gateway,
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    auditRepo,
    // No `pool` → caller-ID identification is skipped → unknown caller lands
    // in ask_caller (the state under test).
    ...(opts.withCustomerRepo === false ? {} : { customerRepo }),
  });
  return { adapter, store, customerRepo, auditRepo, gateway };
}

async function startUnknownCaller(
  h: ReturnType<typeof makeHarness>,
  callSid: string,
): Promise<string> {
  await h.adapter.handleInbound({
    callSid,
    from: CALLER_PHONE,
    to: '+15125550000',
    tenantId: TENANT,
  });
  const session = h.store.findByCallSid(callSid)!;
  // Precondition: with no Pool the unknown caller is parked in ask_caller.
  expect(session.machine.currentState).toBe('ask_caller');
  return session.id;
}

describe('ask_caller on the Gather/PSTN path', () => {
  it('advances an unknown caller out of ask_caller to intake (find-or-create fires)', async () => {
    const h = makeHarness();
    const sessionId = await startUnknownCaller(h, 'CA-ask-1');

    const twiml = await h.adapter.handleGather({
      sessionId,
      callSid: 'CA-ask-1',
      speechResult: "yeah this is John, my water heater's leaking",
      confidence: 0.9,
      tenantId: TENANT,
    });

    const session = h.store.get(sessionId)!;

    // 1. The FSM advanced OUT of ask_caller — the bug was an infinite loop here.
    expect(session.machine.currentState).toBe('intent_capture');

    // 2. find-or-create fired: a real customer now exists, keyed by the caller
    //    phone, and is pinned on the session for the booking that follows.
    expect(session.customerId).toBeTruthy();
    const customer = await h.customerRepo.findById(TENANT, session.customerId!);
    expect(customer).not.toBeNull();
    expect(customer!.primaryPhone).toBe(CALLER_PHONE);

    // 3. The next TwiML is the intake prompt on a fresh <Gather>, NOT a bare
    //    ask_caller reprompt loop.
    expect(twiml).toContain('How can I help you today?');
    expect(twiml).toContain('<Gather');
  });

  it('without a customerRepo, falls back to the FSM unknown_caller retry (no crash, no advance)', async () => {
    const h = makeHarness({ withCustomerRepo: false });
    const sessionId = await startUnknownCaller(h, 'CA-ask-2');

    const twiml = await h.adapter.handleGather({
      sessionId,
      callSid: 'CA-ask-2',
      speechResult: 'it is John',
      confidence: 0.9,
      tenantId: TENANT,
    });

    const session = h.store.get(sessionId)!;
    // No repo/phone find-or-create → the shared handler dispatches
    // unknown_caller, which the FSM turns into a bounded retry reprompt (still
    // ask_caller), never a customer and never a silent no-op.
    expect(session.machine.currentState).toBe('ask_caller');
    expect(session.customerId).toBeUndefined();
    expect(twiml).toContain('<Gather');
  });
});
