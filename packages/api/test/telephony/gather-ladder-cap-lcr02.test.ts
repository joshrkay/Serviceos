/**
 * LCR-02 — the Gather silence / low-Confidence ladder at its cap.
 *
 * Before: two empty SpeechResults, or two low-Confidence turns, returned
 * "Let me connect you with a team member" + <Hangup/>. Nobody was paged.
 *
 * After, split on the capping strike's cause:
 *   - low Confidence (the caller is speaking) → the FSM's system_failure:
 *     notify_oncall parks a <Dial> (returned in place of the turn), or the
 *     no-one-available message, or nothing → a voicemail <Record>;
 *   - silence → a voicemail <Record>, and nobody is paged.
 *
 * Real TwilioGatherAdapter + real escalateToHuman over an in-memory on-call
 * rotation; only the gateway is stubbed (and never called by the ladder).
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { DefaultTwilioCallControl } from '../../src/telephony/twilio-call-control';
import { InMemoryOnCallRepository, type OnCallEntry } from '../../src/oncall/rotation';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';

const TENANT = 'tenant-lcr02-gather';
const DISPATCHER = '+15125550101';
const CALLER = '+15125550100';

const CONNECT_LINE = 'Let me connect you with a team member';
const SILENCE_VOICEMAIL_LINE =
  'I haven&apos;t been able to hear you. If you still need help, please leave a message after the tone.';
const NO_HANDOFF_VOICEMAIL_LINE =
  'I&apos;m sorry, I wasn&apos;t able to connect you to a team member. Please leave a message after the tone.';

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

/** `rotation`: on-call entries; `[]` = nobody on call; `null` = no on-call repo wired. */
async function harness(rotation: OnCallEntry[] | null = [{ id: 'r1', userId: 'u1', orderIndex: 0 }]) {
  const store = new VoiceSessionStore({ startInterval: false });
  const auditRepo = new InMemoryAuditRepository();
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: gateway(),
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://api.test',
    auditRepo,
    ...(rotation !== null
      ? {
          onCallRepo: new InMemoryOnCallRepository(new Map([[TENANT, rotation]])),
          callControl: new DefaultTwilioCallControl(),
          dispatcherPhoneResolver: async () => DISPATCHER,
        }
      : {}),
  });
  vi.spyOn(
    (adapter as unknown as { processor: { runSummary: (s: unknown) => Promise<void> } }).processor,
    'runSummary',
  ).mockResolvedValue(undefined);
  await adapter.handleInbound({ callSid: 'CA-lcr02', from: CALLER, to: '+15125550999', tenantId: TENANT });
  const session = store.findByCallSid('CA-lcr02')!;
  if (session.machine.currentState === 'ask_caller') {
    session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
  }
  const turn = (speechResult: string, confidence?: number) =>
    adapter.handleGather({
      sessionId: session.id,
      callSid: 'CA-lcr02',
      speechResult,
      confidence,
      tenantId: TENANT,
    });
  const escalationAudits = () => auditRepo.getAll().filter((e) => e.eventType.startsWith('escalation'));
  return { adapter, session, turn, escalationAudits };
}

describe('LCR-02 Gather ladder — low Confidence at the cap escalates for real', () => {
  it('two low-Confidence turns page on-call and return the <Dial>, not a hang-up', async () => {
    const h = await harness();
    expect(await h.turn('mumbled one', 0.3)).toContain('<Gather');

    const xml = await h.turn('mumbled two', 0.2);

    expect(xml).toContain('<Dial');
    expect(xml).toContain(DISPATCHER);
    expect(xml).not.toContain('<Hangup');
    expect(h.escalationAudits().length).toBeGreaterThan(0);
    expect(h.session.machine.currentState).toBe('escalating');
    // /dial-result stamps a bridged call's outcome.
    expect(h.session.terminalOutcome).toBeUndefined();
  });

  it('nobody on call: the no-one-available message, never "connect you"', async () => {
    const h = await harness([]);
    await h.turn('mumbled one', 0.3);

    const xml = await h.turn('mumbled two', 0.2);

    expect(xml).not.toContain('<Dial');
    expect(xml).toContain('no one is available right now');
    expect(xml).not.toContain(CONNECT_LINE);
    expect(h.session.terminalReason).toBe('low_stt_confidence_max_retries');
  });

  it('nothing parked (no on-call wiring): a voicemail <Record>, never "connect you"', async () => {
    const h = await harness(null);
    await h.turn('mumbled one', 0.3);

    const xml = await h.turn('mumbled two', 0.2);

    expect(xml).toContain('<Record');
    expect(xml).toContain(NO_HANDOFF_VOICEMAIL_LINE);
    expect(xml).toContain('https://api.test/api/telephony/voicemail-status');
    expect(xml).not.toContain(CONNECT_LINE);
    expect(h.session.ended).toBe(true);
    expect(h.session.terminalReason).toBe('low_stt_confidence_max_retries');
  });

  it('silence then a low-Confidence turn caps on the low Confidence: <Dial>', async () => {
    const h = await harness();
    await h.turn('');

    const xml = await h.turn('mumbled garbage', 0.3);

    expect(xml).toContain('<Dial');
    expect(h.escalationAudits().length).toBeGreaterThan(0);
  });
});

describe('LCR-02 Gather ladder — a silent line at the cap takes a voicemail and pages nobody', () => {
  it('two empty SpeechResults return a voicemail <Record> even with someone on call', async () => {
    const h = await harness();
    expect(await h.turn('')).toContain('<Gather');

    const xml = await h.turn('   ');

    expect(xml).toContain('<Record');
    expect(xml).toContain(SILENCE_VOICEMAIL_LINE);
    expect(xml).toContain('From=%2B15125550100');
    expect(xml).not.toContain('<Dial');
    expect(xml).not.toContain(CONNECT_LINE);
    expect(h.escalationAudits()).toHaveLength(0);
    expect(h.session.machine.currentState).not.toBe('escalating');
    expect(h.session.ended).toBe(true);
    expect(h.session.terminalReason).toBe('silence_max_retries');
  });

  it('a low-Confidence turn then silence caps on the silence: voicemail, no page', async () => {
    const h = await harness();
    await h.turn('mumbled one', 0.3);

    const xml = await h.turn('');

    expect(xml).toContain('<Record');
    expect(h.escalationAudits()).toHaveLength(0);
  });

  it('speaks the voicemail line in Spanish, in the Spanish voice, on an es call', async () => {
    const h = await harness();
    h.session.language = 'es';
    await h.turn('');

    const xml = await h.turn('');

    expect(xml).toContain('Polly.Mia-Neural');
    expect(xml).toContain('No he podido escucharle.');
    expect(xml).toContain('<Record');
  });
});
