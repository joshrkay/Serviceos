/**
 * PRIV-4 (review round 1) — a /voice webhook retry (Twilio timed out on the
 * first response and re-POSTed the same CallSid) must still tell the caller
 * they are talking to a virtual assistant.
 *
 * Twilio discards the first response, so the caller hears ONLY the replay's
 * document. It used to be "One moment, please." + <Gather>: the FSM was
 * already past the greeting, the caller was never told, and the first
 * attempt had already ledgered `virtual_assistant_notice.played`.
 *
 * Seam: TwilioGatherAdapter#handleInbound, called twice with one CallSid.
 */
import { describe, expect, it, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { VoicePersona } from '../../src/settings/voice-persona-resolver';

const NOTICE = "Just so you know, I'm a virtual assistant, not a live person.";
const RECORDING_NOTICE =
  'This call may be recorded for quality and training purposes. By continuing, you consent to this recording.';

function gateway(): LLMGateway {
  const response: LLMResponse = {
    content: '{"intentType":"unknown","confidence":0,"reasoning":"x"}',
    model: 'mock',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

function says(twiml: string): string[] {
  return [...twiml.matchAll(/<Say[^>]*>([^<]*)<\/Say>/g)].map((m) => m[1].replace(/&apos;/g, "'"));
}

const call = { callSid: 'CA-replay', from: '+15125550100', to: '+15125550999', tenantId: 'tenant-replay' };

describe('PRIV-4 — a /voice retry still carries the virtual-assistant notice', () => {
  it('a retry after the first response was built replays the same greeting, notice included', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: gateway(),
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://example.com',
    });

    const first = await adapter.handleInbound(call);
    const replay = await adapter.handleInbound(call);

    const greeting = says(first)[0];
    expect(greeting).toContain(NOTICE);
    expect(says(replay)[0]).toBe(greeting);
    // The replay never arms a second recording.
    expect(replay).not.toContain('<Record');
  });

  it('a retry that arrives while the first attempt is still establishing speaks the notice and the recording notice', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    let releasePersona!: (p: VoicePersona | null) => void;
    const personaGate = new Promise<VoicePersona | null>((resolve) => {
      releasePersona = resolve;
    });
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: gateway(),
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://example.com',
      voicePersonaResolver: () => personaGate,
    });

    const firstPending = adapter.handleInbound(call);
    for (let i = 0; i < 50 && !store.findByCallSid(call.callSid); i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    expect(store.findByCallSid(call.callSid)).toBeDefined();

    const replay = await adapter.handleInbound(call);
    expect(says(replay)[0]).toBe(`${NOTICE} ${RECORDING_NOTICE} One moment, please.`);

    releasePersona(null);
    await firstPending;
  });
});
