/**
 * Characterization — what the Gather lookup path does TODAY.
 *
 * Safety net for moving the lookup family out of `_handleGatherLocked` into a
 * shared module both live transports can reach (#838 Q1). The move must be
 * behaviour-preserving on Gather; these pin the behaviours that would
 * otherwise change silently.
 *
 * Existing coverage was partial: `lookup-catalog-owner-gate.test.ts` pins the
 * catalog gate and `twilio-adapter.test.ts` the three OWNER lookups. Nothing
 * covered the customer-scoped family, the anonymous-caller refusal, or the
 * not-wired fallback — which is most of what `runLookupSkill` does.
 *
 * These are deliberately about OBSERVABLE behaviour (what the caller hears,
 * whether the repo was read) rather than internal structure, so they keep
 * holding after the code moves.
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';

const tenantId = 'tenant-lk';
const NOT_WIRED = 'I&apos;m having trouble pulling that up right now';

function gatewayReturning(intentType: string): LLMGateway {
  const response: LLMResponse = {
    content: JSON.stringify({ intentType, confidence: 0.96 }),
    model: 'stub',
    provider: 'stub',
    latencyMs: 1,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  } as unknown as LLMResponse;
  return { complete: vi.fn(async () => response) } as unknown as LLMGateway;
}

function makeAdapter(opts: {
  intentType: string;
  ownerSession?: boolean;
  identified?: boolean;
  deps?: Record<string, unknown>;
}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: gatewayReturning(opts.intentType),
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    ...(opts.deps ?? {}),
  } as never);
  const callSid = `CA-${opts.intentType}-${opts.ownerSession ? 'own' : 'cust'}`;
  const session = store.create(tenantId, 'telephony', {
    callSid,
    ...(opts.ownerSession ? { ownerSession: true, extendedIntents: true } : {}),
  });
  session.machine.dispatch({
    type: 'incoming_call',
    tenantId,
    callSid,
    from: '+15125550111',
    to: '+15125550000',
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  if (opts.identified !== false) {
    session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
    session.customerId = 'cust-1';
  }
  return { adapter, session, callSid };
}

const ask = (h: ReturnType<typeof makeAdapter>, speech: string) =>
  h.adapter.handleGather({
    sessionId: h.session.id,
    callSid: h.callSid,
    speechResult: speech,
    confidence: 0.95,
    tenantId,
  });

describe('Gather lookup dispatch — characterization', () => {
  it('an unidentified caller never reaches a lookup — identification intercepts first', async () => {
    // NOTE: `runLookupSkill`'s own `!customerId` refusal ("I can't pull up
    // your account without identifying you first") is effectively unreachable
    // through handleGather — the FSM holds the turn in `identifying` before
    // the lookup branch is consulted. Pinned as-is: the move must not
    // accidentally make that guard load-bearing, or start running lookups for
    // unidentified callers.
    const jobRepo = { findByCustomer: vi.fn(async () => []) };
    const h = makeAdapter({
      intentType: 'lookup_jobs',
      identified: false,
      deps: { jobRepo },
    });

    await ask(h, 'what jobs do I have');

    expect(h.session.machine.currentState).toBe('identifying');
    expect(jobRepo.findByCustomer).not.toHaveBeenCalled();
  });

  it('a lookup with no repo wired speaks the not-wired fallback', async () => {
    const h = makeAdapter({ intentType: 'lookup_invoices' });

    const xml = await ask(h, 'what do I owe');

    expect(xml).toContain(NOT_WIRED);
  });

  it.each([
    'lookup_my_day',
    'lookup_materials',
    'lookup_job_profit',
  ])('%s has no case today and falls to the not-wired fallback', async (intentType) => {
    // The #843 gap, pinned as CURRENT behaviour so the move is provably
    // behaviour-preserving. When #843 is fixed these expectations flip —
    // deliberately, in that change, not silently in this one.
    const h = makeAdapter({ intentType });

    const xml = await ask(h, 'tell me about that');

    expect(xml).toContain(NOT_WIRED);
  });

  it.each(['lookup_crew_schedule', 'lookup_timesheets'])(
    '%s is owner-routed and falls to the owner fallback',
    async (intentType) => {
      const h = makeAdapter({ intentType, ownerSession: true });

      const xml = await ask(h, 'tell me about that');

      expect(xml).toContain(NOT_WIRED);
    },
  );

  it('an owner lookup on a NON-owner session is refused', async () => {
    const h = makeAdapter({ intentType: 'lookup_day_overview', ownerSession: false });

    const xml = await ask(h, "what's my day look like");

    expect(xml).toContain(NOT_WIRED);
  });

  it('the turn stays in intent_capture — a lookup never advances the FSM', async () => {
    // runLookupSkill deliberately does NOT dispatch intent_classified, so the
    // caller can immediately ask something else. Losing this on the move would
    // strand every lookup in a confirm loop.
    const h = makeAdapter({ intentType: 'lookup_invoices' });
    await ask(h, 'what do I owe');

    expect(h.session.machine.currentState).toBe('intent_capture');
  });
});

/**
 * The success path and its telemetry.
 *
 * Flagged by code review: the net above pinned refusals, fallbacks and the FSM
 * contract, but nothing pinned a lookup actually SUCCEEDING — the caller
 * hearing the skill's summary — or the VQ-003 `lookup_executed` event. Those
 * are the parts most likely to break silently in a relocation, because a
 * broken one still returns a plausible string.
 */
describe('Gather lookup dispatch — success path', () => {
  it('speaks the skill summary and keeps the conversation open', async () => {
    const findByCustomer = vi.fn(async () => []);
    const h = makeAdapter({
      intentType: 'lookup_jobs',
      deps: {
        jobRepo: { findByCustomer, findById: vi.fn(async () => null) },
        appointmentRepo: { findByCustomer: vi.fn(async () => []) },
      },
    });

    const xml = await ask(h, 'what jobs do I have open');

    // The skill ran against the repo rather than degrading to the fallback.
    expect(findByCustomer).toHaveBeenCalled();
    expect(xml).not.toContain(NOT_WIRED);
    // runLookupSkill appends this so the caller can immediately ask again.
    expect(xml).toContain('Anything else');
  });

  it('emits a lookup_executed event on the session bus', async () => {
    // VQ-003 telemetry. Emitted on BOTH the success and error branches, so the
    // harness can see that a lookup was attempted even when it fell back.
    const events: string[] = [];
    const h = makeAdapter({
      intentType: 'lookup_jobs',
      deps: {
        jobRepo: { findByCustomer: vi.fn(async () => []), findById: vi.fn(async () => null) },
        appointmentRepo: { findByCustomer: vi.fn(async () => []) },
      },
    });
    h.session.events.on('voice-event', (e: { type?: string }) => {
      if (e?.type) events.push(e.type);
    });

    await ask(h, 'what jobs do I have open');

    expect(events).toContain('lookup_executed');
  });
});
