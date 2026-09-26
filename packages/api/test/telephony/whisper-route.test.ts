import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { whisperRouter } from '../../src/telephony/whisper-route';
import { WhisperCache } from '../../src/telephony/whisper-cache';
import {
  requireTwilioSignature,
  type TwilioAuthTokenGetter,
} from '../../src/telephony/twilio-signature';

const TENANT_A = 'tenant-whisper-a';
const TENANT_B = 'tenant-whisper-b';

describe('GET /api/telephony/whisper/:escalationId', () => {
  it('returns TwiML <Say> with the cached whisper text', async () => {
    const cache = new WhisperCache();
    cache.set('esc_abc', 'Incoming call from Sarah Chen.', TENANT_A);
    const app = express();
    app.use('/api/telephony', whisperRouter({ whisperCache: cache }));

    const res = await request(app).get('/api/telephony/whisper/esc_abc');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.text).toContain('<Say>');
    expect(res.text).toContain('Incoming call from Sarah Chen.');
  });

  it('returns 200 with empty <Response> when escalationId is unknown (caller still connects)', async () => {
    const cache = new WhisperCache();
    const app = express();
    app.use('/api/telephony', whisperRouter({ whisperCache: cache }));
    const res = await request(app).get('/api/telephony/whisper/nonexistent');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response/>');
  });

  it('escapes XML in the whisper text', async () => {
    const cache = new WhisperCache();
    cache.set('esc_xml', 'Caller said: <urgent> & "rush"', TENANT_A);
    const app = express();
    app.use('/api/telephony', whisperRouter({ whisperCache: cache }));
    const res = await request(app).get('/api/telephony/whisper/esc_xml');
    expect(res.text).not.toContain('<urgent>');
    expect(res.text).toContain('&lt;urgent&gt;');
    expect(res.text).toContain('&amp;');
    expect(res.text).toContain('&quot;');
  });
});

/**
 * #1084 (3) — the whisper TwiML carries the caller's name, phone and intent,
 * and is served by an escalation id alone. An unguessable id is not
 * authorization (#1072's premise): the entry records its tenant and the route
 * compares it with the tenant whose credential verified the GET. A mismatch
 * answers the existing empty whisper — never a 403, which would risk dropping
 * the dispatcher leg.
 */
describe('GET /api/telephony/whisper/:escalationId — tenant check (#1084)', () => {
  const PUBLIC_BASE_URL = 'https://api.test';
  const TOKENS: Record<string, { token: string; tenantId: string }> = {
    ACaaaa: { token: 'token-a', tenantId: TENANT_A },
    ACbbbb: { token: 'token-b', tenantId: TENANT_B },
  };
  /** AccountSid-keyed view, as the whisper mount uses (subaccount_lookup). */
  const getter: TwilioAuthTokenGetter = ({ accountSid }) => {
    const hit = accountSid ? TOKENS[accountSid] : undefined;
    return hit
      ? { outcome: 'verify', authToken: hit.token, path: 'subaccount_lookup', tenantId: hit.tenantId }
      : { outcome: 'verify', authToken: 'deployment-token', path: 'deployment_fallback' };
  };

  function build(cache: WhisperCache) {
    const app = express();
    app.use(
      '/api/telephony/whisper',
      requireTwilioSignature(getter, { publicBaseUrl: PUBLIC_BASE_URL }),
    );
    app.use('/api/telephony', whisperRouter({ whisperCache: cache }));
    return app;
  }

  /** Twilio fetches the whisper URL with a GET; the call params ride the query. */
  function signedGet(app: express.Application, escalationId: string, accountSid: string, token: string) {
    const path = `/api/telephony/whisper/${escalationId}?AccountSid=${accountSid}`;
    const sig = twilio.getExpectedTwilioSignature(token, `${PUBLIC_BASE_URL}${path}`, {});
    return request(app).get(path).set('X-Twilio-Signature', sig);
  }

  it("tenant A's own credential fetching tenant B's escalation gets the empty whisper", async () => {
    const cache = new WhisperCache();
    cache.set('esc_b', 'Incoming call from a B customer.', TENANT_B);
    const res = await signedGet(build(cache), 'esc_b', 'ACaaaa', 'token-a');

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response/>');
    expect(res.text).not.toContain('B customer');
  });

  it("tenant B's own credential fetching its own escalation gets the whisper text", async () => {
    const cache = new WhisperCache();
    cache.set('esc_b', 'Incoming call from a B customer.', TENANT_B);
    const res = await signedGet(build(cache), 'esc_b', 'ACbbbb', 'token-b');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Incoming call from a B customer.');
  });

  it('the deployment-wide token (no tenant implied) still gets the whisper — single-account deployments', async () => {
    const cache = new WhisperCache();
    cache.set('esc_b', 'Incoming call from a B customer.', TENANT_B);
    const res = await signedGet(build(cache), 'esc_b', 'ACdeploy', 'deployment-token');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Incoming call from a B customer.');
  });
});
