import { describe, it, expect, vi } from 'vitest';
import twilio from 'twilio';
import express from 'express';
import request from 'supertest';
import {
  verifyTwilioSignature,
  requireTwilioSignature,
  reconstructWebhookUrl,
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

// Suppress unused-vi warning if all tests skip mocks.
void vi;
