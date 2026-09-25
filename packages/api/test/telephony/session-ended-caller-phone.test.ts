/**
 * AI-minute billing needs the caller's number at call end: the test-call
 * exclusion keys on it, and it is stored on each usage row.
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryVoiceSessionRepository } from '../../src/voice/voice-session';
import type { LLMGateway } from '../../src/ai/gateway/gateway';

const TENANT = 't-session-ended-caller';
const MINUTE_MS = 60_000;

function makeHarness() {
  const store = new VoiceSessionStore({ startInterval: false });
  const onSessionEnded = vi.fn(async () => {});
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: { complete: vi.fn() } as unknown as LLMGateway,
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    maxCallDurationMs: MINUTE_MS,
    voiceSessionRepo: new InMemoryVoiceSessionRepository(),
    onSessionEnded,
  });
  const processor = (adapter as unknown as { processor: { runSummary: (s: unknown) => Promise<void> } })
    .processor;
  vi.spyOn(processor, 'runSummary').mockResolvedValue(undefined);
  return { store, adapter, onSessionEnded };
}

/** Drives one inbound Gather call past the duration cap so it ends. */
async function runCallToEnd(h: ReturnType<typeof makeHarness>, callSid: string) {
  await h.adapter.handleInbound({
    callSid,
    from: '+15125557788',
    to: '+15125550000',
    tenantId: TENANT,
  });
  const session = h.store.findByCallSid(callSid)!;
  session.createdAt = new Date(Date.now() - MINUTE_MS - 1_000);
  await h.adapter.handleGather({
    sessionId: session.id,
    callSid,
    speechResult: 'thanks, bye',
    confidence: 0.9,
    tenantId: TENANT,
  });
}

describe('onSessionEnded', () => {
  it('fires exactly once when an inbound call ends', async () => {
    const h = makeHarness();
    await runCallToEnd(h, 'CA-ended-once');

    await vi.waitFor(() => expect(h.onSessionEnded).toHaveBeenCalled());
    expect(h.onSessionEnded).toHaveBeenCalledTimes(1);
    expect(h.onSessionEnded).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, channel: 'voice_inbound', callSid: 'CA-ended-once' }),
    );
  });

  it("carries the Twilio caller's number on the session-ended event", async () => {
    const h = makeHarness();
    await runCallToEnd(h, 'CA-caller-phone');

    await vi.waitFor(() => expect(h.onSessionEnded).toHaveBeenCalled());
    expect(h.onSessionEnded).toHaveBeenCalledWith(
      expect.objectContaining({ callerPhone: '+15125557788' }),
    );
  });
});
