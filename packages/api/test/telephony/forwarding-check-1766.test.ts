/**
 * D-044 / #1766 — the call-forwarding check at the inbound voice webhook.
 *
 * Handler-level: the real telephony router and the real ForwardingCheckService
 * (in-memory repos), with Twilio mocked at the REST boundary (fetchImpl) and
 * the AI adapter / voice gate spied so we can assert the check call never
 * reaches them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createTelephonyRouter } from '../../src/routes/telephony';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import {
  FORWARDING_CHECK_TTL_MS,
  describeForwardingCheck,
  ForwardingCheckService,
  InMemoryForwardingCheckRepository,
} from '../../src/onboarding/forwarding-check';
import { InMemoryCallForwardingRepository } from '../../src/onboarding/call-forwarding';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { ValidationError } from '../../src/shared/errors';

const AUTH_TOKEN = 'test-tw-token-forwarding-check';
const PUBLIC_BASE_URL = 'https://api.test';
const TENANT = 'tenant-fwd-check';
const RIVET = '+15125550123';
const BUSINESS = '+15125550999';
const OWNER = { id: 'u-owner', role: 'owner' };

function twilioOk(sid = 'CA-test-call') {
  return vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ sid }) }) as unknown as Response);
}

describe('forwarding check — inbound webhook', () => {
  let now: Date;
  let repo: InMemoryForwardingCheckRepository;
  let forwardingRepo: InMemoryCallForwardingRepository;
  let auditRepo: InMemoryAuditRepository;
  let fetchImpl: ReturnType<typeof twilioOk>;
  let businessPhone: string | null;
  let service: ForwardingCheckService;
  let adapter: TwilioGatherAdapter;
  let handleInbound: ReturnType<typeof vi.spyOn>;
  let voiceGate: ReturnType<typeof vi.fn>;
  let app: express.Application;

  beforeEach(async () => {
    now = new Date('2026-10-22T12:00:00Z');
    repo = new InMemoryForwardingCheckRepository();
    forwardingRepo = new InMemoryCallForwardingRepository();
    await forwardingRepo.save(TENANT, { carrier: 'verizon', mode: 'missed' });
    auditRepo = new InMemoryAuditRepository();
    fetchImpl = twilioOk();
    businessPhone = '(512) 555-0999';
    service = new ForwardingCheckService({
      repo,
      forwardingRepo,
      getBusinessPhone: async () => businessPhone,
      getCreds: async () => ({
        accountSid: 'ACtest',
        authToken: 'tok',
        messagingServiceSid: null,
        phoneE164: RIVET,
        credentialVersion: 1,
      }),
      auditRepo,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });

    const store = new VoiceSessionStore();
    adapter = new TwilioGatherAdapter({
      store,
      gateway: { complete: vi.fn() } as unknown as LLMGateway,
      businessName: 'Test Co',
      publicBaseUrl: PUBLIC_BASE_URL,
    });
    handleInbound = vi.spyOn(adapter, 'handleInbound');
    voiceGate = vi.fn(async () => ({ allowed: true }));
    app = express();
    app.use(
      '/api/telephony',
      createTelephonyRouter({
        adapter,
        authTokenGetter: () => AUTH_TOKEN,
        publicBaseUrl: PUBLIC_BASE_URL,
        resolveTenantId: () => TENANT,
        voiceGate,
        forwardingCheck: service,
      }),
    );
  });

  function inbound(params: Record<string, string>) {
    const path = '/api/telephony/voice';
    const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${PUBLIC_BASE_URL}${path}`, params);
    return request(app).post(path).set('X-Twilio-Signature', sig).type('form').send(params);
  }

  const forwarded = { CallSid: 'CA-forwarded-1', From: RIVET, To: RIVET };

  it('places the test call from the Rivet number to the business number via Twilio', async () => {
    const { check, view } = await service.start(TENANT, OWNER);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACtest/Calls.json');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('From')).toBe(RIVET);
    expect(body.get('To')).toBe(BUSINESS);
    expect(body.get('Twiml')).toBe('<Response><Hangup/></Response>');
    expect(check.callSid).toBe('CA-test-call');
    expect(view.status).toBe('pending');
    expect(view.guidance).toMatch(/ring out/i);
    await expect(auditRepo.findByEntity(TENANT, 'call_forwarding_check', check.id)).resolves.toHaveLength(1);
  });

  it('recognises the forwarded call: passes the check, hangs up, never starts the AI', async () => {
    const { check } = await service.start(TENANT, OWNER);
    now = new Date(now.getTime() + 20_000);

    const res = await inbound(forwarded);

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Hangup');
    expect(res.text).not.toContain('<Gather');
    expect(res.text).not.toContain('<Connect');
    expect(handleInbound).not.toHaveBeenCalled();
    expect(voiceGate).not.toHaveBeenCalled();

    expect((await repo.latest(TENANT))?.status).toBe('passed');
    expect((await forwardingRepo.get(TENANT))?.checkPassedAt).toEqual(now);
    const events = await auditRepo.findByEntity(TENANT, 'call_forwarding_check', check.id);
    expect(events.map((e) => e.eventType)).toEqual([
      'call_forwarding.check_started',
      'call_forwarding.check_passed',
    ]);
  });

  it('a pass the line no longer backs (number changed mid-check) is voided: hangs up, owner told to test again', async () => {
    const { check } = await service.start(TENANT, OWNER);
    now = new Date(now.getTime() + 20_000);
    // The repoint landed between the check settling and the stamp.
    vi.spyOn(forwardingRepo, 'recordCheckPassed').mockResolvedValueOnce(false);

    const res = await inbound(forwarded);

    expect(res.text).toContain('<Hangup');
    expect(handleInbound).not.toHaveBeenCalled();
    const latest = await repo.latest(TENANT);
    expect(latest?.status).toBe('failed');
    expect(describeForwardingCheck(latest!, 'missed').guidance).not.toMatch(/Forwarding works/);
    expect((await forwardingRepo.get(TENANT))?.checkPassedAt).toBeNull();
    const events = await auditRepo.findByEntity(TENANT, 'call_forwarding_check', check.id);
    expect(events.map((e) => e.eventType)).toEqual([
      'call_forwarding.check_started',
      'call_forwarding.check_passed',
      'call_forwarding.check_failed',
    ]);
    expect(events[2].metadata).toMatchObject({ reason: 'number_changed' });
  });

  it('a second call with the same caller id after the pass goes to the AI as normal', async () => {
    await service.start(TENANT, OWNER);
    await inbound(forwarded);

    const res = await inbound({ ...forwarded, CallSid: 'CA-forwarded-2' });

    expect(res.text).toContain('<Gather');
    expect(handleInbound).toHaveBeenCalledTimes(1);
  });

  it('an ordinary customer call during a pending check is not mistaken for it', async () => {
    await service.start(TENANT, OWNER);

    const res = await inbound({ CallSid: 'CA-customer', From: '+15125550100', To: RIVET });

    expect(res.text).toContain('<Gather');
    expect(handleInbound).toHaveBeenCalledTimes(1);
    expect((await repo.latest(TENANT))?.status).toBe('pending');
  });

  it('a call after the window closes is a normal call and the check times out with guidance', async () => {
    const { check } = await service.start(TENANT, OWNER);
    now = new Date(now.getTime() + FORWARDING_CHECK_TTL_MS + 1000);

    const res = await inbound(forwarded);
    expect(res.text).toContain('<Gather');

    const view = await service.latestView(TENANT, OWNER);
    expect(view?.status).toBe('timed_out');
    expect(view?.guidance).toMatch(/did not come back/i);
    expect(view?.guidance).toMatch(/ring out/i);
    const events = await auditRepo.findByEntity(TENANT, 'call_forwarding_check', check.id);
    expect(events.map((e) => e.eventType)).toContain('call_forwarding.check_timed_out');
    expect((await forwardingRepo.get(TENANT))?.checkPassedAt).toBeNull();
  });

  it('Twilio refusing the call fails the check with guidance and an audit event', async () => {
    fetchImpl.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) } as unknown as Response);

    const { check, view } = await service.start(TENANT, OWNER);

    expect(check.status).toBe('failed');
    expect(view.guidance).toMatch(/couldn't place the test call/i);
    const events = await auditRepo.findByEntity(TENANT, 'call_forwarding_check', check.id);
    expect(events.map((e) => e.eventType)).toEqual([
      'call_forwarding.check_started',
      'call_forwarding.check_failed',
    ]);
  });

  it('will not start without a carrier or a business phone', async () => {
    businessPhone = null;
    await expect(service.start(TENANT, OWNER)).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();

    businessPhone = '(512) 555-0999';
    await expect(service.start('tenant-without-setup', OWNER)).rejects.toBeInstanceOf(ValidationError);
  });

  it('missed-calls guidance says to let it ring; all-calls guidance does not', async () => {
    const missed = (await service.start(TENANT, OWNER)).view.guidance;
    await forwardingRepo.save(TENANT, { carrier: 'verizon', mode: 'all' });
    const all = (await service.start(TENANT, OWNER)).view.guidance;
    expect(missed).toMatch(/let it ring out/i);
    expect(all).toMatch(/should not ring/i);
  });
});
