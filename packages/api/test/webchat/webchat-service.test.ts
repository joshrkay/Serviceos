/**
 * #1737 — web chat service at the handler seam: the real voice-turn processor
 * with a scripted (mocked) gateway and in-memory repos. Pins the public-path
 * controls (flag, toggle, kill switches, token, origin, bot check, limits,
 * daily caps), that turns run through the SAME pipeline as a phone call, that
 * nothing executes without a proposal, and the hand-off / escalation paths.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createVoiceTurnProcessor } from '../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryLeadRepository } from '../../src/leads/in-memory-lead';
import { InMemorySettingsRepository, type TenantSettings } from '../../src/settings/settings';
import type { LLMGateway, LLMRequest } from '../../src/ai/gateway/gateway';
import { setOwnerNotifications } from '../../src/notifications/owner-notifications-instance';
import { InMemoryWebchatConfigRepository } from '../../src/webchat/webchat-config';
import { InMemoryWebchatUsageRepository, usageDay } from '../../src/webchat/webchat-usage';
import {
  createWebchatService,
  MAX_MESSAGE_CHARS,
  MAX_TURNS_PER_SESSION,
  WebchatError,
} from '../../src/webchat/webchat-service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://rivera-hvac.example.com';

const BOOKING = JSON.stringify({
  intentType: 'create_appointment',
  confidence: 0.93,
  extractedEntities: { jobReference: 'HVAC service' },
});
const OPERATOR = JSON.stringify({ intentType: 'operator_request', confidence: 0.95, extractedEntities: {} });
const UNCLEAR = JSON.stringify({ intentType: 'unknown', confidence: 0.2, extractedEntities: {} });

function scriptedGateway(): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest) => {
      const isConfirm = (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent';
      const last = String(req.messages?.[req.messages.length - 1]?.content ?? '');
      const content = isConfirm
        ? JSON.stringify({ answer: 'no', reasoning: 'scripted' })
        : /schedule|book/i.test(last)
          ? BOOKING
          : /human|person|owner/i.test(last)
            ? OPERATOR
            : UNCLEAR;
      return {
        content,
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
  setOwnerNotifications(undefined);
});

async function harness(opts: {
  enabled?: boolean;
  origins?: string[];
  killedGlobally?: boolean;
  flag?: boolean;
  botOk?: boolean | undefined;
  turnCap?: number;
  costCapCents?: number;
  now?: () => Date;
} = {}) {
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const configRepo = new InMemoryWebchatConfigRepository();
  const usageRepo = new InMemoryWebchatUsageRepository();
  const auditRepo = new InMemoryAuditRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const leadRepo = new InMemoryLeadRepository();
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({ tenantId: TENANT, businessName: 'Rivera HVAC', timezone: 'America/Phoenix' } as unknown as TenantSettings);
  const gateway = scriptedGateway();
  const config = await configRepo.upsert(TENANT, {
    enabled: opts.enabled ?? true,
    allowedOrigins: opts.origins ?? [ORIGIN],
    ...(opts.turnCap ? { dailyTurnCap: opts.turnCap } : {}),
    ...(opts.costCapCents ? { dailyCostCapCents: opts.costCapCents } : {}),
  });
  const botVerify = vi.fn(async () => opts.botOk ?? true);
  const notify = vi.fn(async () => undefined);
  setOwnerNotifications({ notify } as never);
  const service = createWebchatService({
    configRepo,
    usageRepo,
    settingsRepo,
    store,
    processorFor: (businessName) =>
      createVoiceTurnProcessor({
        store,
        gateway,
        businessName,
        systemActorId: 'system:webchat',
        auditRepo,
        proposalRepo,
        customerRepo,
        leadRepo,
        settingsRepo,
      }),
    auditRepo,
    leadRepo,
    isEnabledForTenant: async () => opts.flag ?? true,
    globallyKilled: () => opts.killedGlobally ?? false,
    ...(opts.botOk === undefined ? {} : { botVerifier: { verify: botVerify } }),
    bookingUrlFor: (id) => `https://app.example.com/book?t=${id}`,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const token = config.embedToken;
  const start = () => service.startSession({ token, origin: ORIGIN, ip: '1.1.1.1' });
  const say = (sessionId: string, text: string, ip = '1.1.1.1') =>
    service.sendMessage({ token, origin: ORIGIN, ip, sessionId, text });
  return { service, configRepo, usageRepo, auditRepo, proposalRepo, leadRepo, store, gateway, token, notify, start, say, botVerify };
}

async function rejectsWith(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(WebchatError);
  expect((err as WebchatError).code).toBe(code);
}

describe('#1737 — access controls', () => {
  it('is off by default: a tenant that never enabled it is unavailable', async () => {
    const h = await harness({ enabled: false });
    await rejectsWith(h.start(), 'UNAVAILABLE');
  });

  it('is unavailable when the platform tenant flag is off, the tenant is killed, or the global switch is on', async () => {
    await rejectsWith((await harness({ flag: false })).start(), 'UNAVAILABLE');
    await rejectsWith((await harness({ killedGlobally: true })).start(), 'UNAVAILABLE');
    const h = await harness();
    await h.configRepo.upsert(TENANT, { killed: true });
    await rejectsWith(h.start(), 'UNAVAILABLE');
  });

  it('kill switch also stops a chat already in progress', async () => {
    const h = await harness();
    const { sessionId } = await h.start();
    await h.configRepo.upsert(TENANT, { killed: true });
    await rejectsWith(h.say(sessionId, 'hello'), 'UNAVAILABLE');
  });

  it('rejects a wrong, malformed or rotated embed token without saying which', async () => {
    const h = await harness();
    await rejectsWith(h.service.startSession({ token: 'nope', origin: ORIGIN, ip: 'x' }), 'UNAVAILABLE');
    await rejectsWith(
      h.service.startSession({ token: `${TENANT}.${'a'.repeat(24)}`, origin: ORIGIN, ip: 'x' }),
      'UNAVAILABLE',
    );
    const old = h.token;
    await h.configRepo.rotateToken(TENANT);
    await rejectsWith(h.service.startSession({ token: old, origin: ORIGIN, ip: 'x' }), 'UNAVAILABLE');
  });

  it('only allows listed origins; an empty list allows none', async () => {
    const h = await harness();
    await rejectsWith(h.service.startSession({ token: h.token, origin: 'https://evil.example', ip: 'x' }), 'ORIGIN_NOT_ALLOWED');
    await rejectsWith(h.service.startSession({ token: h.token, origin: undefined, ip: 'x' }), 'ORIGIN_NOT_ALLOWED');
    const none = await harness({ origins: [] });
    await rejectsWith(none.start(), 'ORIGIN_NOT_ALLOWED');
  });

  it('runs the bot-check hook on session start and refuses a failed check', async () => {
    const h = await harness({ botOk: false });
    await rejectsWith(h.start(), 'BOT_CHECK_FAILED');
    expect(h.botVerify).toHaveBeenCalledOnce();
    const ok = await harness({ botOk: true });
    await expect(ok.start()).resolves.toMatchObject({ businessName: 'Rivera HVAC' });
  });

  it("a session cannot be used with another tenant's token", async () => {
    const h = await harness();
    const { sessionId } = await h.start();
    const other = await h.configRepo.upsert(OTHER_TENANT, { enabled: true, allowedOrigins: [ORIGIN] });
    await rejectsWith(
      h.service.sendMessage({ token: other.embedToken, origin: ORIGIN, ip: 'x', sessionId, text: 'hi' }),
      'SESSION_NOT_FOUND',
    );
  });
});

describe('#1737 — limits', () => {
  it('caps messages per session per minute', async () => {
    const h = await harness();
    const { sessionId } = await h.start();
    for (let i = 0; i < 8; i++) await h.say(sessionId, 'hello', `10.0.0.${i}`);
    await rejectsWith(h.say(sessionId, 'hello', '10.0.0.99'), 'RATE_LIMITED');
  });

  it('caps messages per IP per minute across sessions', async () => {
    const h = await harness();
    const a = await h.start();
    const b = await h.start();
    for (let i = 0; i < 15; i++) {
      await h.say(a.sessionId, 'hello', '9.9.9.9').catch(() => undefined);
      await h.say(b.sessionId, 'hello', '9.9.9.9').catch(() => undefined);
    }
    await rejectsWith(h.say(a.sessionId, 'hello', '9.9.9.9'), 'RATE_LIMITED');
  });

  it('caps chats started per IP per hour', async () => {
    const h = await harness();
    for (let i = 0; i < 10; i++) await h.start();
    await rejectsWith(h.start(), 'RATE_LIMITED');
  });

  it('caps turns per session', async () => {
    let t = Date.parse('2026-10-22T12:00:00Z');
    const h = await harness({ now: () => new Date(t) });
    const { sessionId } = await h.start();
    for (let i = 0; i < MAX_TURNS_PER_SESSION; i++) {
      t += 20_000; // stays under the per-minute windows
      await h.say(sessionId, 'hello', `8.8.${i}.1`);
    }
    t += 20_000;
    await rejectsWith(h.say(sessionId, 'hello', '8.8.200.1'), 'RATE_LIMITED');
  });

  it('rejects empty and over-long messages', async () => {
    const h = await harness();
    const { sessionId } = await h.start();
    await rejectsWith(h.say(sessionId, '   '), 'VALIDATION_ERROR');
    await rejectsWith(h.say(sessionId, 'x'.repeat(MAX_MESSAGE_CHARS + 1)), 'VALIDATION_ERROR');
  });

  it('stops calling the model once the tenant daily turn cap is reached, and says so', async () => {
    const h = await harness({ turnCap: 2 });
    const { sessionId } = await h.start();
    await h.say(sessionId, 'hello');
    await h.say(sessionId, 'hello again');
    const calls = (h.gateway.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    const capped = await h.say(sessionId, 'one more');
    expect(capped.capped).toBe(true);
    expect(capped.replies[0]).toMatch(/limit for today/i);
    expect((h.gateway.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
    const events = (await h.auditRepo.findByEntity(TENANT, 'webchat_session', sessionId)).map((e) => e.eventType);
    expect(events).toContain('webchat.daily_cap_reached');
  });

  it('stops once the tenant daily cost cap (integer cents) is spent', async () => {
    const h = await harness({ costCapCents: 5 });
    const { sessionId } = await h.start();
    await h.usageRepo.addCost(TENANT, usageDay(new Date()), 5);
    const reply = await h.say(sessionId, 'hello');
    expect(reply.capped).toBe(true);
    expect(h.gateway.complete).not.toHaveBeenCalled();
  });

  it('a new UTC day starts a fresh allowance', async () => {
    let now = new Date('2026-10-22T23:59:00Z');
    const h = await harness({ turnCap: 1, now: () => now });
    const { sessionId } = await h.start();
    expect((await h.say(sessionId, 'hello')).capped).toBe(false);
    expect((await h.say(sessionId, 'hello')).capped).toBe(true);
    now = new Date('2026-10-23T00:01:00Z');
    expect((await h.say(sessionId, 'hello')).capped).toBe(false);
  });
});

describe('#1737 — turns run through the call pipeline, behind the approval gate', () => {
  beforeEach(() => undefined);

  it('greets as an automated assistant, answers a turn, and persists nothing that executes', async () => {
    const h = await harness();
    const started = await h.start();
    expect(started.greeting).toMatch(/automated assistant for Rivera HVAC/);
    expect(started.bookingUrl).toBe(`https://app.example.com/book?t=${TENANT}`);

    const reply = await h.say(started.sessionId, 'I would like to book HVAC service');
    expect(reply.replies.join(' ').length).toBeGreaterThan(0);
    expect(h.store.peek(started.sessionId)?.channel).toBe('telephony');
    expect(h.store.peek(started.sessionId)?.persistChannel).toBe('webchat');
    // Anything drafted is a pending proposal for the owner — never executed.
    for (const p of await h.proposalRepo.findByTenant(TENANT)) {
      expect(['draft', 'ready_for_review', 'pending', 'pending_approval']).toContain(p.status);
    }
  });

  it('emits audit events for the session lifecycle', async () => {
    const h = await harness();
    const { sessionId } = await h.start();
    await h.service.endSession({ token: h.token, origin: ORIGIN, sessionId });
    const types = (await h.auditRepo.findByEntity(TENANT, 'webchat_session', sessionId)).map((e) => e.eventType);
    expect(types).toEqual(expect.arrayContaining(['webchat.session_started', 'webchat.session_ended']));
    await rejectsWith(h.say(sessionId, 'hello'), 'SESSION_NOT_FOUND');
  });
});

describe('#1737 — hand-off and escalation', () => {
  it('captures a lead from the contact form and links the public booking page', async () => {
    const h = await harness();
    const { sessionId } = await h.start();
    await h.say(sessionId, 'hello');
    const result = await h.service.handoff({
      token: h.token,
      origin: ORIGIN,
      ip: '1.1.1.1',
      sessionId,
      name: 'Pat Visitor',
      phone: '+15555550123',
      note: 'AC is down',
      requestOwner: false,
    });
    expect(result.bookingUrl).toBe(`https://app.example.com/book?t=${TENANT}`);
    const leads = await h.leadRepo.findByTenant(TENANT);
    expect(leads).toHaveLength(1);
    expect(leads[0]!.primaryPhone).toBe('+15555550123');
    expect(leads[0]!.sourceDetail).toContain('Web chat');
    expect(leads[0]!.createdBy).toBe('public:webchat');
    const types = (await h.auditRepo.findByEntity(TENANT, 'webchat_session', sessionId)).map((e) => e.eventType);
    expect(types).toContain('webchat.handoff');
    expect(h.notify).not.toHaveBeenCalledWith(TENANT, 'escalation', expect.anything());
  });

  it('needs a phone or email to hand off', async () => {
    const h = await harness();
    const { sessionId } = await h.start();
    await rejectsWith(
      h.service.handoff({ token: h.token, origin: ORIGIN, ip: 'x', sessionId, name: 'Pat', requestOwner: false }),
      'VALIDATION_ERROR',
    );
  });

  it('asking for the owner notifies the owner once and audits the escalation', async () => {
    const h = await harness();
    const { sessionId } = await h.start();
    for (let i = 0; i < 2; i++) {
      await h.service.handoff({
        token: h.token,
        origin: ORIGIN,
        ip: '1.1.1.1',
        sessionId,
        name: 'Pat',
        email: 'pat@example.com',
        requestOwner: true,
      });
    }
    const escalations = h.notify.mock.calls.filter((c) => (c as unknown[])[1] === 'escalation');
    expect(escalations).toHaveLength(1);
    const types = (await h.auditRepo.findByEntity(TENANT, 'webchat_session', sessionId)).map((e) => e.eventType);
    expect(types).toContain('webchat.escalated');
  });

  it('"I want to talk to a person" escalates to the owner instead of dialling anyone', async () => {
    const h = await harness();
    const { sessionId } = await h.start();
    const reply = await h.say(sessionId, 'Can I talk to a real person?');
    expect(reply.escalated).toBe(true);
    expect(reply.replies.length).toBeGreaterThan(0);
    expect(h.gateway.complete).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith(TENANT, 'escalation', expect.objectContaining({ reason: expect.stringContaining('Web chat') }));
  });
});
