/**
 * D2-3 — phone-number → tenant lookup for inbound Twilio /voice.
 *
 * Confirms the env-var fallback (`TWILIO_DEFAULT_TENANT_ID`) is refused in
 * production / staging and that unknown numbers receive the "not in service"
 * decline TwiML + a Sentry error event instead of silently routing to a
 * default tenant.
 *
 * Mirrors the harness style in test/telephony/telephony-routes.test.ts but
 * exercises the resolution branch specifically.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createTelephonyRouter } from '../../src/routes/telephony';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemoryPhoneNumberRepository } from '../../src/integrations/twilio/phone-number-repository';
import type { SentryClient } from '../../src/monitoring/sentry';

const AUTH_TOKEN = 'test-tw-token-xyz';
const PUBLIC_BASE_URL = 'https://api.test';
const TENANT_ID = 'tenant-d2-3-test';
const DEFAULT_TENANT_ID = 'tenant-d2-3-default';
const KNOWN_NUMBER = '+15125550999';
const UNKNOWN_NUMBER = '+18005551234';

function makeGateway(content: string): LLMGateway {
  const response: LLMResponse = {
    content,
    model: 'mock',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

function makeFakeSentry(): SentryClient & {
  captures: Array<{ message: string; level: string }>;
} {
  const captures: Array<{ message: string; level: string }> = [];
  return {
    captures,
    captureException: () => 'no-op',
    captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info') {
      captures.push({ message, level });
      return 'captured';
    },
    setTag: () => {},
    setUser: () => {},
    startTransaction: () => ({ finish: () => {}, setStatus: () => {} }),
    withScope: <T>(cb: (scope: { setTag(): void; captureException(): string }) => T): T =>
      cb({
        setTag: () => {},
        captureException: () => 'noop',
      }),
  };
}

interface HarnessOpts {
  /** Pre-seed numbers → tenant. */
  numbers?: Record<string, string>;
  /** Override NODE_ENV the route sees. */
  nodeEnv: 'production' | 'prod' | 'staging' | 'development' | 'dev' | 'test';
  /** If false, the legacy resolveTenantId callback returns undefined. */
  legacyResolves?: boolean;
}

function buildHarness(opts: HarnessOpts) {
  const store = new VoiceSessionStore({ startInterval: false });
  const gateway = makeGateway(
    JSON.stringify({
      intentType: 'create_invoice',
      confidence: 0.91,
      reasoning: 'clear command',
      extractedEntities: {},
    }),
  );
  const adapter = new TwilioGatherAdapter({
    store,
    gateway,
    businessName: 'Test Co',
    publicBaseUrl: PUBLIC_BASE_URL,
  });

  const phoneRepo = new InMemoryPhoneNumberRepository(opts.numbers ?? {});
  const sentry = makeFakeSentry();
  const legacyResolveSpy = vi.fn(() =>
    opts.legacyResolves ? DEFAULT_TENANT_ID : undefined,
  );

  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter,
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: PUBLIC_BASE_URL,
      phoneNumberRepo: phoneRepo,
      resolveTenantId: legacyResolveSpy,
      sentry,
      nodeEnv: opts.nodeEnv,
    }),
  );

  return { app, store, phoneRepo, sentry, legacyResolveSpy };
}

function signedVoice(
  app: express.Application,
  params: Record<string, string>,
) {
  const path = '/api/telephony/voice';
  const url = `${PUBLIC_BASE_URL}${path}`;
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return request(app)
    .post(path)
    .set('X-Twilio-Signature', sig)
    .type('form')
    .send(params);
}

describe('D2-3 inbound /voice tenant resolution', () => {
  const originalEnv = process.env.TWILIO_DEFAULT_TENANT_ID;

  beforeEach(() => {
    delete process.env.TWILIO_DEFAULT_TENANT_ID;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.TWILIO_DEFAULT_TENANT_ID = originalEnv;
    } else {
      delete process.env.TWILIO_DEFAULT_TENANT_ID;
    }
    vi.restoreAllMocks();
  });

  it('found number → 200 + Gather TwiML, session uses resolved tenant', async () => {
    const { app, store, sentry } = buildHarness({
      nodeEnv: 'production',
      numbers: { [KNOWN_NUMBER]: TENANT_ID },
    });

    const res = await signedVoice(app, {
      CallSid: 'CA-known-1',
      From: '+15125550100',
      To: KNOWN_NUMBER,
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.text).toContain('<Gather');
    expect(res.text).not.toMatch(/not in service/i);
    expect(sentry.captures).toHaveLength(0);

    const sessions = Array.from(
      (store as unknown as { sessions: Map<string, { tenantId: string }> }).sessions.values(),
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tenantId).toBe(TENANT_ID);
  });

  it('not found in prod → 200 + "not in service" TwiML, NOT the default tenant', async () => {
    process.env.TWILIO_DEFAULT_TENANT_ID = DEFAULT_TENANT_ID;
    const { app, store, sentry, legacyResolveSpy } = buildHarness({
      nodeEnv: 'production',
      numbers: { [KNOWN_NUMBER]: TENANT_ID },
      legacyResolves: true,
    });

    const res = await signedVoice(app, {
      CallSid: 'CA-unknown-prod',
      From: '+15125550100',
      To: UNKNOWN_NUMBER,
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.text).toMatch(/not in service/i);
    expect(res.text).toContain('<Hangup');
    // Crucially: the legacy resolver MUST NOT be consulted in prod, and no
    // adapter session must have been created.
    expect(legacyResolveSpy).not.toHaveBeenCalled();
    const sessions = Array.from(
      (store as unknown as { sessions: Map<string, unknown> }).sessions.values(),
    );
    expect(sessions).toHaveLength(0);
    // Sentry receives an error event.
    expect(sentry.captures).toContainEqual({
      message: 'telephony.tenant_lookup_miss',
      level: 'error',
    });
  });

  it('not found in staging → also rejected (production-like)', async () => {
    process.env.TWILIO_DEFAULT_TENANT_ID = DEFAULT_TENANT_ID;
    const { app, sentry, legacyResolveSpy } = buildHarness({
      nodeEnv: 'staging',
      numbers: {},
      legacyResolves: true,
    });

    const res = await signedVoice(app, {
      CallSid: 'CA-unknown-staging',
      From: '+15125550100',
      To: UNKNOWN_NUMBER,
    });

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/not in service/i);
    expect(legacyResolveSpy).not.toHaveBeenCalled();
    expect(sentry.captures.some((c) => c.message === 'telephony.tenant_lookup_miss')).toBe(true);
  });

  it('not found in dev WITH TWILIO_DEFAULT_TENANT_ID set → uses fallback + WARN logged', async () => {
    process.env.TWILIO_DEFAULT_TENANT_ID = DEFAULT_TENANT_ID;
    const { app, store, sentry } = buildHarness({
      nodeEnv: 'development',
      numbers: {},
      legacyResolves: false,
    });

    // The JSON logger writes directly to process.stdout — not console.* —
    // so spy on stdout.write to capture the dev-fallback warning line.
    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: unknown) => {
        stdoutChunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    const res = await signedVoice(app, {
      CallSid: 'CA-unknown-dev-fallback',
      From: '+15125550100',
      To: UNKNOWN_NUMBER,
    });

    stdoutSpy.mockRestore();

    expect(res.status).toBe(200);
    // Falls through to the adapter → Gather TwiML.
    expect(res.text).toContain('<Gather');
    // Session created with the env-var tenant.
    const sessions = Array.from(
      (store as unknown as { sessions: Map<string, { tenantId: string }> }).sessions.values(),
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tenantId).toBe(DEFAULT_TENANT_ID);

    // No Sentry miss event — dev with fallback is "intentional".
    expect(sentry.captures).toHaveLength(0);
    // Loud WARN log via the JSON logger (writes to process.stdout).
    const combined = stdoutChunks.join('');
    expect(combined).toMatch(/"level":"warn"/);
    expect(combined).toContain('telephony.tenant_lookup_dev_fallback');
    expect(combined).toContain('TWILIO_DEFAULT_TENANT_ID');
  });

  it('not found in dev with NO fallback configured → 200 + "not in service" TwiML', async () => {
    // TWILIO_DEFAULT_TENANT_ID intentionally unset (beforeEach deletes it).
    const { app, store, sentry, legacyResolveSpy } = buildHarness({
      nodeEnv: 'development',
      numbers: {},
      legacyResolves: false,
    });

    const res = await signedVoice(app, {
      CallSid: 'CA-unknown-dev-bare',
      From: '+15125550100',
      To: UNKNOWN_NUMBER,
    });

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/not in service/i);
    expect(res.text).toContain('<Hangup');
    // Legacy resolver IS consulted in dev, but returned undefined.
    expect(legacyResolveSpy).toHaveBeenCalledTimes(1);
    const sessions = Array.from(
      (store as unknown as { sessions: Map<string, unknown> }).sessions.values(),
    );
    expect(sessions).toHaveLength(0);
    // Dev miss with nothing configured DOES emit Sentry — see comment in
    // resolveInboundTenantId. This catches local misconfig that would
    // otherwise present as dead air.
    expect(sentry.captures).toContainEqual({
      message: 'telephony.tenant_lookup_miss',
      level: 'error',
    });
  });

  it('repo throws → Sentry sees `telephony.tenant_lookup_error`, prod still declines', async () => {
    const { app, sentry } = buildHarness({
      nodeEnv: 'production',
      numbers: {},
    });

    // Replace the repo with a thrower.
    const throwingRepo = {
      findByNumber: vi.fn().mockRejectedValue(new Error('db boom')),
    };
    const broken = express();
    broken.use(
      '/api/telephony',
      createTelephonyRouter({
        adapter: new TwilioGatherAdapter({
          store: new VoiceSessionStore({ startInterval: false }),
          gateway: makeGateway('{}'),
          businessName: 'Test Co',
          publicBaseUrl: PUBLIC_BASE_URL,
        }),
        authTokenGetter: () => AUTH_TOKEN,
        publicBaseUrl: PUBLIC_BASE_URL,
        phoneNumberRepo: throwingRepo,
        resolveTenantId: () => undefined,
        sentry,
        nodeEnv: 'production',
      }),
    );

    // Silence the structured error log.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await signedVoice(broken, {
      CallSid: 'CA-repo-throw',
      From: '+15125550100',
      To: UNKNOWN_NUMBER,
    });

    // Codex P1 (PR #384) — DB outages MUST surface as 5xx so Twilio's
    // retry policy can recover from transient failures. Previously we
    // 200-declined which made every transient blip look like a
    // permanent "number not in service" misroute.
    expect(res.status).toBe(503);
    expect(res.text).toMatch(/temporarily unavailable/i);
    expect(throwingRepo.findByNumber).toHaveBeenCalledTimes(1);
    // Only the error capture is emitted now — we no longer fall through
    // to the dev-fallback / prod-miss path on infra errors.
    expect(sentry.captures.map((c) => c.message)).toEqual(
      expect.arrayContaining(['telephony.tenant_lookup_error']),
    );
    expect(sentry.captures.map((c) => c.message)).not.toContain(
      'telephony.tenant_lookup_miss',
    );

    // Don't pollute the test app's unrelated harness.
    expect(app).toBeDefined();
  });
});
