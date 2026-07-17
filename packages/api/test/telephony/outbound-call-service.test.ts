import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  initiateOutboundCall,
  OutboundCallError,
  buildBridgeTwiml,
  buildHangupTwiml,
  resolveBridgeTarget,
  type OutboundCallDeps,
} from '../../src/telephony/outbound-call-service';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import { isOutboundAllowed } from '../../src/voice/outbound-allowlist';

const TENANT = 'tenant-call-1';
const CUSTOMER = 'cust-1';
const CUSTOMER_PHONE = '+15551234567';
const AGENT_PHONE = '+15559990000';
const BUSINESS_NUMBER = '+15557778888';

// `customer: undefined` → default customer with a phone; pass `null` for
// not-found, or `{ primaryPhone: undefined }` for a customer with no number.
function buildDeps(
  overrides: Partial<OutboundCallDeps> & { customer?: { id: string; primaryPhone?: string } | null } = {},
): { deps: OutboundCallDeps; conversationRepo: InMemoryConversationRepository; dncRepo: InMemoryDncRepository; fetchMock: ReturnType<typeof vi.fn> } {
  const conversationRepo = new InMemoryConversationRepository();
  const dncRepo = new InMemoryDncRepository();
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({ sid: 'CA123', status: 'queued' }),
    text: async () => '',
  });
  const customer =
    'customer' in overrides ? overrides.customer : { id: CUSTOMER, primaryPhone: CUSTOMER_PHONE };
  const { customer: _omit, ...depOverrides } = overrides;
  const deps: OutboundCallDeps = {
    customerRepo: { findById: vi.fn().mockResolvedValue(customer) },
    conversationRepo,
    dncRepo,
    getCreds: vi.fn().mockResolvedValue({
      accountSid: 'ACxxx',
      authToken: 'tok',
      messagingServiceSid: null,
      phoneE164: BUSINESS_NUMBER,
      credentialVersion: 1,
    }),
    publicApiUrl: 'https://api.example.com',
    fetchImpl: fetchMock as unknown as typeof fetch,
    apiBaseUrl: 'https://twilio.test/2010-04-01',
    ...depOverrides,
  };
  return { deps, conversationRepo, dncRepo, fetchMock };
}

const input = {
  tenantId: TENANT,
  customerId: CUSTOMER,
  agentPhone: AGENT_PHONE,
  actorId: 'owner-1',
  actorRole: 'owner',
};

describe('initiateOutboundCall', () => {
  let env: ReturnType<typeof buildDeps>;
  beforeEach(() => {
    env = buildDeps();
  });

  it('creates a Twilio call (owner→business→customer) and logs it on the timeline', async () => {
    const result = await initiateOutboundCall(env.deps, input);

    expect(result.callSid).toBe('CA123');
    // POSTed to Calls.json with the owner as To and the business number as From.
    expect(env.fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = env.fetchMock.mock.calls[0];
    expect(url).toBe('https://twilio.test/2010-04-01/Accounts/ACxxx/Calls.json');
    const body = new URLSearchParams((options as { body: string }).body);
    expect(body.get('To')).toBe(AGENT_PHONE);
    expect(body.get('From')).toBe(BUSINESS_NUMBER);
    expect(body.get('Url')).toContain('/api/calls/bridge');
    expect(body.get('Url')).toContain(`messageId=${encodeURIComponent(result.messageId)}`);

    // A call_outbound message was threaded onto the customer's conversation.
    const msgs = await env.conversationRepo.getMessages(TENANT, result.conversationId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].source).toBe('outbound_call');
    expect(msgs[0].metadata).toMatchObject({
      direction: 'outbound',
      channel: 'call',
      status: 'ringing',
      callSid: 'CA123',
      target: CUSTOMER_PHONE,
      callerId: BUSINESS_NUMBER,
    });
  });

  it('blocks a DNC-listed customer and never calls Twilio', async () => {
    env.dncRepo.add(TENANT, '15551234567');
    await expect(initiateOutboundCall(env.deps, input)).rejects.toMatchObject({ code: 'dnc_blocked' });
    expect(env.fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a customer with no phone (no_recipient)', async () => {
    const e = buildDeps({ customer: { id: CUSTOMER, primaryPhone: undefined } });
    await expect(initiateOutboundCall(e.deps, input)).rejects.toMatchObject({ code: 'no_recipient' });
    expect(e.fetchMock).not.toHaveBeenCalled();
  });

  it('404s an unknown customer (not_found)', async () => {
    const e = buildDeps({ customer: null });
    await expect(initiateOutboundCall(e.deps, input)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports not_configured when the tenant has no voice number', async () => {
    const e = buildDeps({
      getCreds: vi.fn().mockResolvedValue({
        accountSid: 'ACxxx',
        authToken: 'tok',
        messagingServiceSid: null,
        phoneE164: null,
        credentialVersion: 1,
      }),
    });
    await expect(initiateOutboundCall(e.deps, input)).rejects.toMatchObject({ code: 'not_configured' });
    expect(e.fetchMock).not.toHaveBeenCalled();
  });

  it('reports not_configured (fails closed) when getCreds throws — tenant has no active integration', async () => {
    // The /api/calls gate intentionally no longer requires a global
    // TWILIO_ACCOUNT_SID: in per-tenant prod the route is wired and
    // getTenantTwilioCreds throws for a tenant without a provisioned row.
    // That per-tenant failure must surface as not_configured (→ 503), never a
    // 500, and must never reach Twilio.
    const e = buildDeps({
      getCreds: vi.fn().mockRejectedValue(new Error('No active Twilio integration for tenant')),
    });
    await expect(initiateOutboundCall(e.deps, input)).rejects.toMatchObject({ code: 'not_configured' });
    expect(e.fetchMock).not.toHaveBeenCalled();
  });

  it('marks the message failed and throws provider_failed on a Twilio error', async () => {
    const e = buildDeps();
    e.fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request', json: async () => ({}) });
    await expect(initiateOutboundCall(e.deps, input)).rejects.toMatchObject({ code: 'provider_failed' });
    // The logged message reflects the failure (status: 'failed').
    const convs = await e.conversationRepo.findByEntity(TENANT, 'customer', CUSTOMER);
    const msgs = await e.conversationRepo.getMessages(TENANT, convs[0].id);
    expect(msgs[0].metadata).toMatchObject({ status: 'failed' });
  });

  it('throws OutboundCallError instances', async () => {
    const e = buildDeps({ customer: null });
    await expect(initiateOutboundCall(e.deps, input)).rejects.toBeInstanceOf(OutboundCallError);
  });
});

describe('initiateOutboundCall — TCPA consent gate (TCPA_CONSENT_ENFORCEMENT)', () => {
  const DENIED = { allowed: false as const, reason: 'customer_not_found' as const, message: 'No consent on file' };

  function auditRepo() {
    const events: Array<Record<string, unknown>> = [];
    return { repo: { create: vi.fn(async (e: Record<string, unknown>) => { events.push(e); return e; }) }, events };
  }

  it("'off' (default): places the call even without consent and never runs the gate (prod-parity)", async () => {
    const checkConsent = vi.fn().mockResolvedValue(DENIED);
    const { repo, events } = auditRepo();
    // consentEnforcement omitted → defaults to 'off'.
    const e = buildDeps({ checkConsent, auditRepo: repo });
    const result = await initiateOutboundCall(e.deps, input);

    expect(result.callSid).toBe('CA123');
    expect(e.fetchMock).toHaveBeenCalledTimes(1);
    // Gate is skipped entirely when off — checkConsent is never consulted.
    expect(checkConsent).not.toHaveBeenCalled();
    // No consent audit events emitted in off mode.
    expect(events.some((ev) => String(ev.eventType).startsWith('call.consent_'))).toBe(false);
  });

  it("'block': refuses a non-consented number with consent_blocked, never calls Twilio, audits the block", async () => {
    const checkConsent = vi.fn().mockResolvedValue(DENIED);
    const { repo, events } = auditRepo();
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const e = buildDeps({ consentEnforcement: 'block', checkConsent, auditRepo: repo, logger: logger as never });

    await expect(initiateOutboundCall(e.deps, input)).rejects.toMatchObject({ code: 'consent_blocked' });
    expect(checkConsent).toHaveBeenCalledTimes(1);
    // A block must never reach Twilio and must not log a call message.
    expect(e.fetchMock).not.toHaveBeenCalled();
    const convs = await e.conversationRepo.findByEntity(TENANT, 'customer', CUSTOMER);
    expect(convs).toHaveLength(0);
    // Block is audited + logged.
    const blocked = events.find((ev) => ev.eventType === 'call.consent_blocked');
    expect(blocked).toBeDefined();
    expect(blocked!.metadata).toMatchObject({ mode: 'block', decision: 'blocked', reason: 'customer_not_found' });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("'warn': proceeds for a non-consented number but logs + audits the would-be block", async () => {
    const checkConsent = vi.fn().mockResolvedValue(DENIED);
    const { repo, events } = auditRepo();
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const e = buildDeps({ consentEnforcement: 'warn', checkConsent, auditRepo: repo, logger: logger as never });

    const result = await initiateOutboundCall(e.deps, input);

    expect(result.callSid).toBe('CA123');
    // Warn mode still places the call (observability without breaking prod).
    expect(e.fetchMock).toHaveBeenCalledTimes(1);
    expect(checkConsent).toHaveBeenCalledTimes(1);
    const warned = events.find((ev) => ev.eventType === 'call.consent_warned');
    expect(warned).toBeDefined();
    expect(warned!.metadata).toMatchObject({ mode: 'warn', decision: 'warned' });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("'block': normalizes a formatted stored number to E.164 before the gate (not refused as malformed)", async () => {
    // Regression: the raw `customers.primaryPhone` was passed to the gate, whose
    // format filter (isOutboundAllowed) requires strict `+1XXXXXXXXXX`. A
    // validly-stored formatted number was refused as `malformed` in block mode.
    // The service now normalizes to E.164 first. `checkConsent` here runs the
    // REAL isOutboundAllowed so a non-normalized value would still block.
    const checkConsent = vi.fn(async (ctx: { phoneE164: string }) => {
      const fmt = isOutboundAllowed(ctx.phoneE164);
      return fmt.allowed
        ? { allowed: true as const }
        : { allowed: false as const, reason: fmt.reason, message: 'blocked' };
    });
    const { repo } = auditRepo();
    const e = buildDeps({
      customer: { id: CUSTOMER, primaryPhone: '(555) 111-2222' },
      consentEnforcement: 'block',
      checkConsent,
      auditRepo: repo,
    });

    // Must NOT throw consent_blocked — the number is valid once normalized.
    const result = await initiateOutboundCall(e.deps, input);
    expect(result.callSid).toBe('CA123');
    expect(e.fetchMock).toHaveBeenCalledTimes(1);
    // The gate received the normalized E.164, never the raw formatted string.
    expect(checkConsent).toHaveBeenCalledTimes(1);
    expect(checkConsent.mock.calls[0][0]).toMatchObject({ phoneE164: '+15551112222' });
  });

  it("'block' with consent granted: places the call and audits the grant", async () => {
    const checkConsent = vi.fn().mockResolvedValue({ allowed: true });
    const { repo, events } = auditRepo();
    const e = buildDeps({ consentEnforcement: 'block', checkConsent, auditRepo: repo });

    const result = await initiateOutboundCall(e.deps, input);

    expect(result.callSid).toBe('CA123');
    expect(e.fetchMock).toHaveBeenCalledTimes(1);
    const granted = events.find((ev) => ev.eventType === 'call.consent_granted');
    expect(granted).toBeDefined();
    expect(granted!.metadata).toMatchObject({ mode: 'block', decision: 'granted' });
  });
});

describe('bridge TwiML builders', () => {
  it('dials the customer with the business caller-ID, escaping XML', async () => {
    const xml = buildBridgeTwiml({ customerPhone: '+15551234567', callerId: '+15557778888' });
    expect(xml).toContain('<Dial callerId="+15557778888">');
    expect(xml).toContain('<Number>+15551234567</Number>');
  });

  it('produces a polite hangup when the target is unresolved', () => {
    expect(buildHangupTwiml()).toContain('<Hangup/>');
  });
});

describe('resolveBridgeTarget', () => {
  const callMsg = {
    id: 'm1',
    source: 'outbound_call',
    metadata: { target: '+15551234567', callerId: '+15557778888' },
  };

  it('returns the customer phone + caller-id for an outbound_call log', () => {
    expect(resolveBridgeTarget([callMsg], 'm1')).toEqual({
      customerPhone: '+15551234567',
      callerId: '+15557778888',
    });
  });

  it('returns null for a missing message id', () => {
    expect(resolveBridgeTarget([callMsg], 'nope')).toBeNull();
  });

  it('returns null when the message is not an outbound_call log (never dials a stray target)', () => {
    const textMsg = { id: 'm2', source: 'sms', metadata: { target: '+19998887777', callerId: '+1' } };
    expect(resolveBridgeTarget([textMsg], 'm2')).toBeNull();
  });

  it('returns null when target/callerId metadata is absent', () => {
    expect(resolveBridgeTarget([{ id: 'm3', source: 'outbound_call', metadata: {} }], 'm3')).toBeNull();
  });
});
