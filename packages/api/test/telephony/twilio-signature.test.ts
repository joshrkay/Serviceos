import { describe, it, expect, vi } from 'vitest';
import twilio from 'twilio';
import express from 'express';
import request from 'supertest';
import {
  verifyTwilioSignature,
  requireTwilioSignature,
  reconstructWebhookUrl,
  type TwilioAuthTokenGetter,
} from '../../src/telephony/twilio-signature';

const AUTH_TOKEN = 'test-auth-token-abc123';

function buildApp(authTokenGetter: () => string | undefined, publicBaseUrl?: string) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(requireTwilioSignature(authTokenGetter, { publicBaseUrl }));
  app.post('/voice', (_req, res) => {
    res.status(200).type('text/xml').send('<Response/>');
  });
  return app;
}

describe('verifyTwilioSignature', () => {
  it('returns true for a valid Twilio signature', () => {
    const url = 'https://example.com/api/telephony/voice';
    const params = { CallSid: 'CA123', From: '+15125550100', To: '+15125550999' };
    const expected = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
    expect(verifyTwilioSignature(expected, url, params, AUTH_TOKEN)).toBe(true);
  });

  it('returns false for an invalid signature', () => {
    const url = 'https://example.com/api/telephony/voice';
    const params = { CallSid: 'CA123' };
    expect(verifyTwilioSignature('not-a-real-sig', url, params, AUTH_TOKEN)).toBe(false);
  });

  it('returns false when signature header is missing', () => {
    expect(verifyTwilioSignature(undefined, 'https://x', {}, AUTH_TOKEN)).toBe(false);
  });

  it('returns false when authToken is empty', () => {
    expect(verifyTwilioSignature('any', 'https://x', {}, '')).toBe(false);
  });
});

describe('reconstructWebhookUrl', () => {
  it('uses publicBaseUrl when provided', () => {
    const req = {
      originalUrl: '/api/telephony/voice?sid=abc',
      get: () => 'localhost:3000',
      protocol: 'http',
      headers: {},
    } as unknown as express.Request;
    expect(reconstructWebhookUrl(req, 'https://api.example.com')).toBe(
      'https://api.example.com/api/telephony/voice?sid=abc'
    );
  });

  it('strips trailing slash from publicBaseUrl', () => {
    const req = {
      originalUrl: '/foo',
      get: () => 'localhost',
      protocol: 'http',
      headers: {},
    } as unknown as express.Request;
    expect(reconstructWebhookUrl(req, 'https://api.example.com/')).toBe(
      'https://api.example.com/foo'
    );
  });

  it('falls back to req.protocol + host when no base URL', () => {
    const req = {
      originalUrl: '/api/telephony/voice',
      get: () => 'example.com',
      protocol: 'https',
      headers: {},
    } as unknown as express.Request;
    expect(reconstructWebhookUrl(req)).toBe('https://example.com/api/telephony/voice');
  });

  it('honors X-Forwarded-Proto header', () => {
    const req = {
      originalUrl: '/x',
      get: () => 'example.com',
      protocol: 'http',
      headers: { 'x-forwarded-proto': 'https' },
    } as unknown as express.Request;
    expect(reconstructWebhookUrl(req)).toBe('https://example.com/x');
  });
});

describe('requireTwilioSignature middleware', () => {
  it('passes through requests with a valid signature', async () => {
    const baseUrl = 'https://example.com';
    const app = buildApp(() => AUTH_TOKEN, baseUrl);
    const params = { CallSid: 'CA456', From: '+15125550100', To: '+15125550999' };
    const sig = twilio.getExpectedTwilioSignature(
      AUTH_TOKEN,
      `${baseUrl}/voice`,
      params
    );

    const res = await request(app)
      .post('/voice')
      .set('X-Twilio-Signature', sig)
      .type('form')
      .send(params);

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response');
  });

  it('rejects requests with an invalid signature with 403', async () => {
    const app = buildApp(() => AUTH_TOKEN, 'https://example.com');
    const res = await request(app)
      .post('/voice')
      .set('X-Twilio-Signature', 'definitely-wrong')
      .type('form')
      .send({ CallSid: 'CA456' });

    expect(res.status).toBe(403);
  });

  it('rejects requests missing the signature header with 403', async () => {
    const app = buildApp(() => AUTH_TOKEN, 'https://example.com');
    const res = await request(app)
      .post('/voice')
      .type('form')
      .send({ CallSid: 'CA456' });

    expect(res.status).toBe(403);
  });

  it('returns 500 when auth token is unset (fail-closed)', async () => {
    const app = buildApp(() => undefined, 'https://example.com');
    const res = await request(app)
      .post('/voice')
      .set('X-Twilio-Signature', 'anything')
      .type('form')
      .send({ CallSid: 'CA456' });

    expect(res.status).toBe(500);
  });

  it('reads auth token lazily from the getter on each request', async () => {
    let token: string | undefined = AUTH_TOKEN;
    const app = buildApp(() => token, 'https://example.com');
    const params = { CallSid: 'CA1' };
    const sig = twilio.getExpectedTwilioSignature(
      AUTH_TOKEN,
      'https://example.com/voice',
      params
    );

    const ok = await request(app)
      .post('/voice')
      .set('X-Twilio-Signature', sig)
      .type('form')
      .send(params);
    expect(ok.status).toBe(200);

    token = undefined;
    const fail = await request(app)
      .post('/voice')
      .set('X-Twilio-Signature', sig)
      .type('form')
      .send(params);
    expect(fail.status).toBe(500);
  });
});

/**
 * #1072 — the middleware no longer takes just a token: the resolver it calls
 * may REFUSE (the presented credential does not belong to the tenant that owns
 * the dialled number) or report the deployment cannot produce a credential at
 * all. Both answers are given before any handler runs.
 */
describe('requireTwilioSignature — credential decisions (#1072)', () => {
  function buildDecisionApp(
    getter: TwilioAuthTokenGetter,
    publicBaseUrl = 'https://example.com',
  ) {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(requireTwilioSignature(getter, { publicBaseUrl }));
    app.post('/voice', (_req, res) => {
      res.status(200).type('text/xml').send('<Response/>');
    });
    return app;
  }

  const params = { CallSid: 'CA789', From: '+15125550100', To: '+15125550999' };
  const validSig = () =>
    twilio.getExpectedTwilioSignature(AUTH_TOKEN, 'https://example.com/voice', params);

  it('refuses with 403 — and never reaches the handler — on an outcome of "refuse"', async () => {
    const handler = vi.fn();
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(
      requireTwilioSignature(
        () => ({ outcome: 'refuse', reason: 'account_sid_not_owned_by_dialled_number_tenant' }),
        { publicBaseUrl: 'https://example.com' },
      ),
    );
    app.post('/voice', handler);

    // A signature that would otherwise be perfectly valid: the refusal is the
    // binding, not a bad HMAC.
    const res = await request(app)
      .post('/voice')
      .set('X-Twilio-Signature', validSig())
      .type('form')
      .send(params);

    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 500 on an outcome of "misconfigured" (fail-closed, operator-visible)', async () => {
    const app = buildDecisionApp(() => ({
      outcome: 'misconfigured',
      reason: 'tenant_encryption_key_missing',
    }));

    const res = await request(app)
      .post('/voice')
      .set('X-Twilio-Signature', validSig())
      .type('form')
      .send(params);

    expect(res.status).toBe(500);
  });

  it('verifies against the token carried by an outcome of "verify"', async () => {
    const app = buildDecisionApp(() => ({
      outcome: 'verify',
      authToken: AUTH_TOKEN,
      path: 'tenant_integration',
      tenantId: 'tenant-a',
    }));

    const ok = await request(app)
      .post('/voice')
      .set('X-Twilio-Signature', validSig())
      .type('form')
      .send(params);
    expect(ok.status).toBe(200);

    const wrongToken = buildDecisionApp(() => ({
      outcome: 'verify',
      authToken: 'some-other-tenants-token',
      path: 'tenant_integration',
    }));
    const refused = await request(wrongToken)
      .post('/voice')
      .set('X-Twilio-Signature', validSig())
      .type('form')
      .send(params);
    expect(refused.status).toBe(403);
  });

  it('hands the resolver the dialled number from To, from Called, and from the query', async () => {
    const seen: Array<{ accountSid?: string; to?: string }> = [];
    const getter = vi.fn((ctx: { accountSid?: string; to?: string }) => {
      seen.push(ctx);
      return AUTH_TOKEN;
    });
    const app = buildDecisionApp(getter);

    await request(app).post('/voice').type('form').send({ AccountSid: 'AC1', To: '+15125550999' });
    await request(app).post('/voice').type('form').send({ Called: '+15125550888' });
    // The voicemail callback mints `To` onto its own callback URL because
    // Twilio's recordingStatusCallback body carries neither To nor Called.
    await request(app).post('/voice?To=%2B15125550777').type('form').send({ CallSid: 'CA1' });

    expect(seen).toEqual([
      { accountSid: 'AC1', to: '+15125550999' },
      { to: '+15125550888' },
      { to: '+15125550777' },
    ]);
  });
});

// Suppress unused-vi warning if all tests skip mocks.
void vi;
