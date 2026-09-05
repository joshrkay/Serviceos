/**
 * #859 / plan U7 (R7) — every caller utterance lands in the transcript
 * EXACTLY once, on every transport.
 *
 * Before this fix the media-streams path appended twice: the mediastream
 * adapter's `speechTurn` dep is `TwilioGatherAdapter#processCallerUtterance`
 * (app.ts wiring), which appends and then delegates to the processor's
 * `speechTurn`, which appended again. PR #974 only wrapped the second site
 * in an empty-utterance condition that any spoken line satisfies, so the
 * doubled `caller:` lines survived into every recorded summary.
 *
 * Three entry points are driven here:
 *   - media-streams via the adapter (`processCallerUtterance`, the shipped
 *     `speechTurn` dep),
 *   - the processor's `speechTurn` called directly (the mediastream adapter's
 *     own call shape — a regression pin for a future rewire), and
 *   - Gather (`handleGather`, which classifies inline and never reaches
 *     `speechTurn`).
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { createVoiceTurnProcessor } from '../../src/ai/voice-turn';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';

const UNKNOWN_INTENT = '{"intentType":"unknown","confidence":0,"reasoning":"x"}';

function makeGateway(): LLMGateway {
  const response: LLMResponse = {
    content: UNKNOWN_INTENT,
    model: 'mock-model',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

/**
 * A real store with `appendTranscript` spied (not stubbed) so the transcript
 * the turn reads back stays coherent, plus an adapter whose session is
 * advanced to `intent_capture` — the state every entry point classifies in.
 */
async function makeHarness(callSid: string) {
  const store = new VoiceSessionStore({ startInterval: false });
  const appendSpy = vi.spyOn(store, 'appendTranscript');
  const gateway = makeGateway();
  const adapter = new TwilioGatherAdapter({
    store,
    gateway,
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
  });
  await adapter.handleInbound({
    callSid,
    from: '+15125550100',
    to: '+15125550999',
    tenantId: 'tenant-abc',
  });
  const session = store.findByCallSid(callSid);
  if (!session) throw new Error('harness: session not created');
  if (session.machine.currentState === 'ask_caller') {
    session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
  }
  // Only caller lines count — handleInbound itself appends the agent greeting.
  const callerLines = (): string[] =>
    appendSpy.mock.calls
      .filter(([, entry]) => entry.speaker === 'caller')
      .map(([, entry]) => entry.text);
  return { store, gateway, adapter, session, callerLines };
}

describe('#859 — one transcript append per caller utterance', () => {
  it('media-streams via the adapter (processCallerUtterance → speechTurn): exactly one append', async () => {
    const { adapter, session, callerLines } = await makeHarness('CA-ms-once');

    await adapter.processCallerUtterance({
      sessionId: session.id,
      callSid: 'CA-ms-once',
      speechResult: 'my water heater is leaking',
      tenantId: 'tenant-abc',
    });

    expect(callerLines()).toEqual(['my water heater is leaking']);
  });

  it('processor speechTurn called directly: exactly one append', async () => {
    const { store, gateway, session, callerLines } = await makeHarness('CA-direct-once');
    const processor = createVoiceTurnProcessor({
      store,
      gateway,
      businessName: 'Acme Plumbing',
      systemActorId: 'test-actor',
    });

    await processor.speechTurn({
      session,
      speechResult: 'my water heater is leaking',
      callSid: 'CA-direct-once',
      tenantId: 'tenant-abc',
    });

    expect(callerLines()).toEqual(['my water heater is leaking']);
  });

  it('Gather (handleGather): exactly one append', async () => {
    const { adapter, session, callerLines } = await makeHarness('CA-gather-once');

    await adapter.handleGather({
      sessionId: session.id,
      callSid: 'CA-gather-once',
      speechResult: 'my water heater is leaking',
      confidence: 0.95,
      tenantId: 'tenant-abc',
    });

    expect(callerLines()).toEqual(['my water heater is leaking']);
  });

  it('a caller who genuinely repeats the same line gets two entries, not a dedupe', async () => {
    const { adapter, session, callerLines } = await makeHarness('CA-ms-repeat');

    for (let i = 0; i < 2; i++) {
      await adapter.processCallerUtterance({
        sessionId: session.id,
        callSid: 'CA-ms-repeat',
        speechResult: 'hello, can you hear me',
        tenantId: 'tenant-abc',
      });
    }

    expect(callerLines()).toEqual(['hello, can you hear me', 'hello, can you hear me']);
  });

  it('an empty media-streams final appends nothing at either site', async () => {
    // Matches the Gather guard: an empty `caller:` line would make
    // deriveCallOutcome read a silent call as caller speech.
    const { adapter, session, callerLines } = await makeHarness('CA-ms-empty');

    await adapter.processCallerUtterance({
      sessionId: session.id,
      callSid: 'CA-ms-empty',
      speechResult: '',
      tenantId: 'tenant-abc',
    });

    expect(callerLines()).toEqual([]);
  });
});
