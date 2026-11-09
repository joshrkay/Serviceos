/**
 * U5 — absolute per-call duration cap on the Twilio Gather/PSTN path.
 *
 * The Gather transport has no timer of its own: every turn is a fresh
 * webhook, so the cap is enforced by comparing the session's age
 * (`Date.now() - session.createdAt`) against `maxCallDurationMs` at the top
 * of each Gather turn. A turn arriving past the limit gets the wrap-up
 * `<Say>` plus `<Hangup/>` (the builder's end_session branch) and the
 * session is finalized with terminal reason `max_call_duration` — never the
 * generic `failed` outcome, because nothing broke.
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter, xmlEscape } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import {
  renderTtsText,
  MAX_CALL_DURATION_WRAP_UP_COPY,
} from '../../src/ai/agents/customer-calling/tts-copy';
import {
  MIN_STT_CONFIDENCE,
  MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS,
} from '../../src/ai/voice-turn/shared/low-stt-ladder';

const TENANT = 't-max-duration';
const MINUTE_MS = 60_000;

function makeGateway(): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: '{"intentType":"unknown","confidence":0,"reasoning":"x"}',
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    })),
  } as unknown as LLMGateway;
}

function makeHarness(
  opts: {
    maxCallDurationMs?: number;
    maxCallDurationMsForTenant?: (tenantId: string) => Promise<number | undefined>;
  } = {},
) {
  const store = new VoiceSessionStore({ startInterval: false });
  const gateway = makeGateway();
  const adapter = new TwilioGatherAdapter({
    store,
    gateway,
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    ...(opts.maxCallDurationMs !== undefined ? { maxCallDurationMs: opts.maxCallDurationMs } : {}),
    ...(opts.maxCallDurationMsForTenant
      ? { maxCallDurationMsForTenant: opts.maxCallDurationMsForTenant }
      : {}),
  });
  return { adapter, store, gateway };
}

async function startCall(
  h: ReturnType<typeof makeHarness>,
  callSid: string,
  ageMs: number,
  tenantId: string = TENANT,
): Promise<string> {
  await h.adapter.handleInbound({
    callSid,
    from: '+15125557788',
    to: '+15125550000',
    tenantId,
  });
  const session = h.store.findByCallSid(callSid)!;
  // Backdate the session so the next Gather turn sees a call of age `ageMs`.
  session.createdAt = new Date(Date.now() - ageMs);
  return session.id;
}

/** White-box spy on the shared turn processor's summary entry point (PR #975 F5). */
function spyRunSummary(adapter: TwilioGatherAdapter) {
  const processor = (adapter as unknown as { processor: { runSummary: (s: unknown) => Promise<void> } })
    .processor;
  return vi.spyOn(processor, 'runSummary').mockResolvedValue(undefined);
}

describe('U5 Gather max call duration', () => {
  it('a turn past the limit gets the wrap-up <Say> + <Hangup/> and the session ends with max_call_duration', async () => {
    const h = makeHarness({ maxCallDurationMs: MINUTE_MS });
    // The terminal branch fires the (best-effort, LLM-backed) call summary;
    // stub it so the gateway assertion below isolates the turn pipeline.
    spyRunSummary(h.adapter);
    const sessionId = await startCall(h, 'CA-cap-g1', MINUTE_MS + 1_000);

    const twiml = await h.adapter.handleGather({
      sessionId,
      callSid: 'CA-cap-g1',
      speechResult: 'and one more thing',
      confidence: 0.9,
      tenantId: TENANT,
    });

    const wrapUp = renderTtsText(MAX_CALL_DURATION_WRAP_UP_COPY, {}, 'en');
    expect(twiml).toContain('<Say');
    // <Say> bodies are XML-escaped (the copy carries apostrophes).
    expect(twiml).toContain(`>${xmlEscape(wrapUp)}</Say>`);
    expect(twiml).toContain('<Hangup/>');
    expect(twiml).not.toContain('<Gather');
    // No LLM turn ran for a call that is over.
    expect(h.gateway.complete).not.toHaveBeenCalled();

    const session = h.store.get(sessionId)!;
    expect(session.ended).toBe(true);
    expect(session.terminalReason).toBe('max_call_duration');
    expect(session.terminalOutcome).toBeDefined();
    expect(session.terminalOutcome).not.toBe('failed');
    // The caller's last utterance is not lost, and the wrap-up is on the transcript.
    expect(
      session.transcript.some((l) => l.startsWith('caller:') && l.includes('one more thing')),
    ).toBe(true);
    expect(session.transcript).toContain(`agent: ${wrapUp}`);
  });

  it('a turn under the limit continues normally on a fresh <Gather>', async () => {
    const h = makeHarness({ maxCallDurationMs: MINUTE_MS });
    const sessionId = await startCall(h, 'CA-cap-g2', MINUTE_MS - 5_000);

    const twiml = await h.adapter.handleGather({
      sessionId,
      callSid: 'CA-cap-g2',
      speechResult: 'this is John',
      confidence: 0.9,
      tenantId: TENANT,
    });

    expect(twiml).toContain('<Gather');
    expect(twiml).not.toContain('<Hangup/>');
    expect(h.store.get(sessionId)!.ended).toBe(false);
  });

  it('speaks the wrap-up in Spanish on an es session', async () => {
    const h = makeHarness({ maxCallDurationMs: MINUTE_MS });
    const sessionId = await startCall(h, 'CA-cap-g3', MINUTE_MS + 1);
    h.store.get(sessionId)!.language = 'es';

    const twiml = await h.adapter.handleGather({
      sessionId,
      callSid: 'CA-cap-g3',
      speechResult: 'una cosa más',
      confidence: 0.9,
      tenantId: TENANT,
    });

    expect(twiml).toContain(xmlEscape(renderTtsText(MAX_CALL_DURATION_WRAP_UP_COPY, {}, 'es')));
    expect(twiml).not.toContain(xmlEscape(renderTtsText(MAX_CALL_DURATION_WRAP_UP_COPY, {}, 'en')));
    expect(twiml).toContain('<Hangup/>');
  });

  it('defaults to 15 minutes when no maxCallDurationMs dep is wired', async () => {
    const h = makeHarness();
    const under = await startCall(h, 'CA-cap-g4', 14 * MINUTE_MS);
    const over = await startCall(h, 'CA-cap-g5', 16 * MINUTE_MS);

    const underTwiml = await h.adapter.handleGather({
      sessionId: under,
      callSid: 'CA-cap-g4',
      speechResult: 'hello',
      confidence: 0.9,
      tenantId: TENANT,
    });
    expect(underTwiml).toContain('<Gather');

    const overTwiml = await h.adapter.handleGather({
      sessionId: over,
      callSid: 'CA-cap-g5',
      speechResult: 'hello',
      confidence: 0.9,
      tenantId: TENANT,
    });
    expect(overTwiml).toContain('<Hangup/>');
    expect(h.store.get(over)!.terminalReason).toBe('max_call_duration');
  });

  // PR #975 review finding 5 — the cap's end path finalized the session but
  // never kicked off `processor.runSummary`, unlike the adapter's other
  // terminal branches, so a capped Gather call got no call_summaries row.
  // The low-STT ladder's terminal branch had the same omission.
  describe('terminal Gather branches kick off the call summary', () => {
    it('a capped call runs the summary once with the session', async () => {
      const h = makeHarness({ maxCallDurationMs: MINUTE_MS });
      const runSummary = spyRunSummary(h.adapter);
      const sessionId = await startCall(h, 'CA-cap-sum-1', MINUTE_MS + 1);

      await h.adapter.handleGather({
        sessionId,
        callSid: 'CA-cap-sum-1',
        speechResult: 'one last thing',
        confidence: 0.9,
        tenantId: TENANT,
      });

      const session = h.store.get(sessionId)!;
      expect(session.terminalReason).toBe('max_call_duration');
      expect(runSummary).toHaveBeenCalledTimes(1);
      expect(runSummary).toHaveBeenCalledWith(session);
    });

    it('the low-STT-confidence ladder end runs the summary once with the session', async () => {
      const h = makeHarness();
      const runSummary = spyRunSummary(h.adapter);
      const sessionId = await startCall(h, 'CA-stt-sum-1', 5_000);

      for (let turn = 0; turn < MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS; turn++) {
        await h.adapter.handleGather({
          sessionId,
          callSid: 'CA-stt-sum-1',
          speechResult: 'mmhm',
          confidence: MIN_STT_CONFIDENCE / 2,
          tenantId: TENANT,
        });
      }

      const session = h.store.get(sessionId)!;
      expect(session.ended).toBe(true);
      expect(session.terminalReason).toBe('low_stt_confidence_max_retries');
      expect(runSummary).toHaveBeenCalledTimes(1);
      expect(runSummary).toHaveBeenCalledWith(session);
    });
  });

  // The public demo line: a per-tenant limit tightens the process-wide cap for
  // the demo tenant only. A real tenant on the same adapter keeps the cap it
  // always had.
  describe('per-tenant limit (demo line)', () => {
    const DEMO_TENANT = 't-demo-line';
    const DEMO_LIMIT_MS = 3 * MINUTE_MS;
    const forTenant = async (tenantId: string) => (tenantId === DEMO_TENANT ? DEMO_LIMIT_MS : undefined);

    it('ends a demo-tenant call at its own limit, well under the 15-minute default', async () => {
      const h = makeHarness({ maxCallDurationMsForTenant: forTenant });
      spyRunSummary(h.adapter);
      const sessionId = await startCall(h, 'CA-demo-g1', DEMO_LIMIT_MS + 1_000, DEMO_TENANT);

      const twiml = await h.adapter.handleGather({
        sessionId,
        callSid: 'CA-demo-g1',
        speechResult: 'one more question',
        confidence: 0.9,
        tenantId: DEMO_TENANT,
      });

      expect(twiml).toContain('<Hangup/>');
      expect(h.store.get(sessionId)!.terminalReason).toBe('max_call_duration');
    });

    it('lets a demo-tenant call continue until its limit', async () => {
      const h = makeHarness({ maxCallDurationMsForTenant: forTenant });
      const sessionId = await startCall(h, 'CA-demo-g2', DEMO_LIMIT_MS - 5_000, DEMO_TENANT);

      const twiml = await h.adapter.handleGather({
        sessionId,
        callSid: 'CA-demo-g2',
        speechResult: 'hello again',
        confidence: 0.9,
        tenantId: DEMO_TENANT,
      });

      expect(twiml).toContain('<Gather');
      expect(h.store.get(sessionId)!.ended).toBe(false);
    });

    it('does not cut a real tenant at the demo limit', async () => {
      const h = makeHarness({ maxCallDurationMsForTenant: forTenant });
      const sessionId = await startCall(h, 'CA-demo-g3', DEMO_LIMIT_MS + 60_000, TENANT);

      const twiml = await h.adapter.handleGather({
        sessionId,
        callSid: 'CA-demo-g3',
        speechResult: 'still here',
        confidence: 0.9,
        tenantId: TENANT,
      });

      expect(twiml).toContain('<Gather');
      expect(h.store.get(sessionId)!.ended).toBe(false);
    });

    it('never loosens the process-wide cap', async () => {
      const h = makeHarness({ maxCallDurationMs: MINUTE_MS, maxCallDurationMsForTenant: forTenant });
      spyRunSummary(h.adapter);
      const sessionId = await startCall(h, 'CA-demo-g4', MINUTE_MS + 1_000, DEMO_TENANT);

      const twiml = await h.adapter.handleGather({
        sessionId,
        callSid: 'CA-demo-g4',
        speechResult: 'hi',
        confidence: 0.9,
        tenantId: DEMO_TENANT,
      });

      expect(twiml).toContain('<Hangup/>');
    });

    it('falls back to the process-wide cap when the resolver throws', async () => {
      const resolver = vi.fn(async (_tenantId: string): Promise<number | undefined> => {
        throw new Error('db down');
      });
      const h = makeHarness({ maxCallDurationMsForTenant: resolver });
      const sessionId = await startCall(h, 'CA-demo-g5', 10 * MINUTE_MS, DEMO_TENANT);

      const twiml = await h.adapter.handleGather({
        sessionId,
        callSid: 'CA-demo-g5',
        speechResult: 'hi',
        confidence: 0.9,
        tenantId: DEMO_TENANT,
      });

      expect(resolver).toHaveBeenCalledWith(DEMO_TENANT);
      expect(twiml).toContain('<Gather');
    });
  });
});
