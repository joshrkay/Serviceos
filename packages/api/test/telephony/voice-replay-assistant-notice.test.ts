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
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });
    }
    expect(store.findByCallSid(call.callSid)).toBeDefined();

    const replay = await adapter.handleInbound(call);
    expect(says(replay)[0]).toBe(`${NOTICE} ${RECORDING_NOTICE} One moment, please.`);

    releasePersona(null);
    await firstPending;
  });

  it("a retry during establishment speaks the tenant's own language and the notice is ledgered once in all", async () => {
    // Codex review on cc8cc8bc: the establishing-retry branch assumed English
    // when bootstrap had not pinned a language yet, and its notice wrote no
    // ledger row of its own.
    const store = new VoiceSessionStore({ startInterval: false });
    const auditRepo = { create: vi.fn(async () => undefined) };
    // Hold the first attempt's language lookup in bootstrap, so the retry
    // lands before the session has a language; the retry's own lookups answer
    // at once.
    let releaseSettings!: () => void;
    const settingsGate = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    let retrying = false;
    let held = 0;
    const settingsRepo = {
      findByTenant: async () => {
        const fromLanguagePin = (new Error().stack ?? '').includes('resolveTenantLanguage');
        if (!retrying && fromLanguagePin) {
          held += 1;
          await settingsGate;
        }
        return { defaultLanguage: 'es' };
      },
    };
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: gateway(),
      businessName: 'Plomería Sol',
      publicBaseUrl: 'https://example.com',
      settingsRepo: settingsRepo as never,
      auditRepo: auditRepo as never,
    });
    const noticeRows = () =>
      auditRepo.create.mock.calls.filter(
        (c: unknown[]) => (c[0] as { eventType: string }).eventType === 'virtual_assistant_notice.played',
      );

    const firstPending = adapter.handleInbound(call);
    for (let i = 0; i < 50 && !(store.findByCallSid(call.callSid) && held > 0); i++) {
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });
    }
    retrying = true;
    const replay = await adapter.handleInbound(call);
    expect(store.findByCallSid(call.callSid)?.language).toBeUndefined();
    expect(says(replay)[0]).toContain('Para que lo sepa, soy un asistente virtual, no una persona real.');
    expect(says(replay)[0]).not.toContain(NOTICE);
    await vi.waitFor(() => expect(noticeRows()).toHaveLength(1));
    expect((noticeRows()[0][0] as { metadata: { language: string } }).metadata.language).toBe('es');

    // The first attempt finishes and commits its greeting: no second row.
    releaseSettings();
    await firstPending;
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });
    expect(noticeRows()).toHaveLength(1);
  });

  it('a retry after the greeting was rendered but before the first attempt committed ledgers the notice once', async () => {
    // Codex review on 9db67fa0: the cached-greeting replay spoke both notices
    // but left the parked ledger thunk for the first attempt, which may be
    // the stalled request Twilio gave up on.
    const store = new VoiceSessionStore({ startInterval: false });
    const auditRepo = { create: vi.fn(async () => undefined) };
    // Hold the first attempt's STT-hints lookup, which runs after bootstrap
    // rendered the greeting and before the first attempt commits.
    let releaseHints!: () => void;
    const hintsGate = new Promise<void>((resolve) => {
      releaseHints = resolve;
    });
    let hintCalls = 0;
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: gateway(),
      businessName: 'Acme Plumbing',
      publicBaseUrl: 'https://example.com',
      auditRepo: auditRepo as never,
      sttHintsResolver: async () => {
        hintCalls += 1;
        if (hintCalls === 1) await hintsGate;
        return [];
      },
    });
    const noticeRows = () =>
      auditRepo.create.mock.calls.filter(
        (c: unknown[]) => (c[0] as { eventType: string }).eventType === 'virtual_assistant_notice.played',
      );

    const firstPending = adapter.handleInbound(call);
    for (let i = 0; i < 50 && hintCalls === 0; i++) {
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });
    }
    expect(store.findByCallSid(call.callSid)?.greetingText).toContain(NOTICE);
    expect(noticeRows()).toHaveLength(0);

    const replay = await adapter.handleInbound(call);
    expect(says(replay)[0]).toContain(NOTICE);
    await vi.waitFor(() => expect(noticeRows()).toHaveLength(1));

    releaseHints();
    await firstPending;
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });
    expect(noticeRows()).toHaveLength(1);
  });
});
