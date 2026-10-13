import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { whisperRouter, mountWhisperRoute } from '../../src/telephony/whisper-route';
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

  it('an unknown escalationId (expired, other process) still gets the generic press-1 screen — never a 404 (H1-R)', async () => {
    const cache = new WhisperCache();
    const app = express();
    app.use('/api/telephony', whisperRouter({ whisperCache: cache }));
    const res = await request(app).get('/api/telephony/whisper/nonexistent?sid=sess-9');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Gather numDigits="1"');
    expect(res.text).toContain('Press 1 to accept this call.');
    expect(res.text).toContain('/api/telephony/whisper/nonexistent/accept?sid=sess-9');
    expect(res.text).toContain('<Hangup/>');
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

  it("tenant A's own credential fetching tenant B's escalation gets only the generic screen", async () => {
    const cache = new WhisperCache();
    cache.set('esc_b', 'Incoming call from a B customer.', TENANT_B);
    const res = await signedGet(build(cache), 'esc_b', 'ACaaaa', 'token-a');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Press 1 to accept this call.');
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

/**
 * #4 — `<Number url>` is fetched with Twilio's DEFAULT method (POST) unless
 * the TwiML says otherwise, and the whisper route used to be GET-only (a POST
 * also failed the signature check: the mount parsed no form body). The TwiML
 * now says method="GET"; the route also answers a signed POST, through the
 * production mount, with the SAME signature verification (POST params are
 * part of what Twilio signs).
 */
describe('whisper mount — POST is served with the same verification (#4)', () => {
  const PUBLIC_BASE_URL = 'https://api.test';
  const getter: TwilioAuthTokenGetter = ({ accountSid }) =>
    accountSid === 'ACaaaa'
      ? { outcome: 'verify', authToken: 'token-a', path: 'subaccount_lookup', tenantId: TENANT_A }
      : { outcome: 'verify', authToken: 'deployment-token', path: 'deployment_fallback' };

  function build(cache: WhisperCache) {
    const app = express();
    mountWhisperRoute(app, {
      whisperCache: cache,
      credentialView: getter,
      publicBaseUrl: () => PUBLIC_BASE_URL,
    });
    return app;
  }

  /** Twilio's POST: the call params ride the form body and are signed with the URL. */
  function signedPost(app: express.Application, escalationId: string, token: string, params: Record<string, string>) {
    const path = `/api/telephony/whisper/${escalationId}`;
    const sig = twilio.getExpectedTwilioSignature(token, `${PUBLIC_BASE_URL}${path}`, params);
    return request(app).post(path).set('X-Twilio-Signature', sig).type('form').send(params);
  }

  it('a signed POST gets the whisper TwiML', async () => {
    const cache = new WhisperCache();
    cache.set('esc_a', 'Incoming call from Sarah Chen.', TENANT_A);
    const res = await signedPost(build(cache), 'esc_a', 'token-a', {
      AccountSid: 'ACaaaa',
      CallSid: 'CA-child',
      To: '+15125550101',
      CallStatus: 'in-progress',
    });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Say>');
    expect(res.text).toContain('Incoming call from Sarah Chen.');
  });

  it('an unsigned (or wrongly signed) POST is refused — verification is not weakened', async () => {
    const cache = new WhisperCache();
    cache.set('esc_a', 'Incoming call from Sarah Chen.', TENANT_A);
    const app = build(cache);

    const unsigned = await request(app)
      .post('/api/telephony/whisper/esc_a')
      .type('form')
      .send({ AccountSid: 'ACaaaa', CallSid: 'CA-child' });
    expect(unsigned.status).toBe(403);

    const forged = await signedPost(app, 'esc_a', 'not-the-token', { AccountSid: 'ACaaaa', CallSid: 'CA-child' });
    expect(forged.status).toBe(403);
    expect(forged.text).not.toContain('Sarah Chen');
  });

  it('a signed GET through the same mount still works', async () => {
    const cache = new WhisperCache();
    cache.set('esc_a', 'Incoming call from Sarah Chen.', TENANT_A);
    const path = '/api/telephony/whisper/esc_a?AccountSid=ACaaaa';
    const sig = twilio.getExpectedTwilioSignature('token-a', `${PUBLIC_BASE_URL}${path}`, {});
    const res = await request(build(cache)).get(path).set('X-Twilio-Signature', sig);

    expect(res.status).toBe(200);
    expect(res.text).toContain('Incoming call from Sarah Chen.');
  });
});

/**
 * H1 (review of #1676) — a carrier voicemail answering the dispatcher leg
 * looks exactly like a human to Twilio (`answered` / DialCallStatus
 * completed). The whisper is therefore a SCREEN: only a human pressing 1
 * accepts the call; anything else hangs up the dialled leg so the Dial
 * reports not-connected and the cascade continues. Only the keypress marks
 * the hand-off answered (which is what resolves the emergency page ladder).
 */
describe('whisper screen — press 1 to accept (H1)', () => {
  const PUBLIC_BASE_URL = 'https://api.test';
  const TOKEN = 'token-a';
  const getter: TwilioAuthTokenGetter = () => ({
    outcome: 'verify',
    authToken: TOKEN,
    path: 'subaccount_lookup',
    tenantId: TENANT_A,
  });

  function build(
    cache: WhisperCache,
    hooks: {
      onAccepted?: (args: {
        sessionId: string;
        tenantId?: string;
        verifiedTenantId?: string;
        childCallSid?: string;
      }) => void | Promise<void>;
    } = {},
  ) {
    const app = express();
    mountWhisperRoute(app, {
      whisperCache: cache,
      credentialView: getter,
      publicBaseUrl: () => PUBLIC_BASE_URL,
      ...(hooks.onAccepted ? { onAccepted: hooks.onAccepted } : {}),
    });
    return app;
  }

  function signed(app: express.Application, path: string, params: Record<string, string>, token = TOKEN) {
    const sig = twilio.getExpectedTwilioSignature(token, `${PUBLIC_BASE_URL}${path}`, params);
    return request(app).post(path).set('X-Twilio-Signature', sig).type('form').send(params);
  }

  it('the screen prompts FIRST, gives the summary, re-prompts once, and only then hangs the leg up (M-a)', async () => {
    const cache = new WhisperCache();
    cache.set('esc_s', 'Emergency call: basement flooding.', TENANT_A, { sessionId: 'sess-1' });
    const res = await signed(build(cache), '/api/telephony/whisper/esc_s', {
      AccountSid: 'ACaaaa',
      CallSid: 'CA-child',
    });

    expect(res.status).toBe(200);
    const accept = 'action="https://api.test/api/telephony/whisper/esc_s/accept?sid=sess-1" method="POST"';
    expect(res.text).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        `<Gather numDigits="1" timeout="10" ${accept}>` +
        '<Say>Incoming call from your answering service. Press 1 to accept this call.</Say>' +
        '<Say>Emergency call: basement flooding.</Say>' +
        '<Say>Press 1 to accept this call.</Say>' +
        '</Gather>' +
        `<Gather numDigits="1" timeout="10" ${accept}><Say>Press 1 to accept this call.</Say></Gather>` +
        '<Hangup/></Response>',
    );
  });

  it('the generic screen (a leg with no whisper text) accepts for the session named in the URL (H1-R)', async () => {
    const onAccepted = vi.fn(async () => undefined);
    const res = await signed(build(new WhisperCache(), { onAccepted }), '/api/telephony/whisper/screen/accept?sid=sess-7', {
      AccountSid: 'ACaaaa',
      CallSid: 'CA-child',
      Digits: '1',
    });

    expect(res.text).toContain('<Response/>');
    expect(onAccepted).toHaveBeenCalledWith({ sessionId: 'sess-7', verifiedTenantId: TENANT_A, childCallSid: 'CA-child' });
  });

  it('pressing 1 connects the call and marks the hand-off answered', async () => {
    const cache = new WhisperCache();
    cache.set('esc_s', 'Emergency call.', TENANT_A, { sessionId: 'sess-1' });
    const onAccepted = vi.fn(async () => undefined);
    const res = await signed(build(cache, { onAccepted }), '/api/telephony/whisper/esc_s/accept', {
      AccountSid: 'ACaaaa',
      CallSid: 'CA-child',
      Digits: '1',
    });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response/>');
    expect(res.text).not.toContain('Hangup');
    expect(onAccepted).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      tenantId: TENANT_A,
      verifiedTenantId: TENANT_A,
      childCallSid: 'CA-child',
    });
  });

  it('any other key declines: the dialled leg hangs up and nothing is marked answered', async () => {
    const cache = new WhisperCache();
    cache.set('esc_s', 'Emergency call.', TENANT_A, { sessionId: 'sess-1' });
    const onAccepted = vi.fn(async () => undefined);
    const res = await signed(build(cache, { onAccepted }), '/api/telephony/whisper/esc_s/accept', {
      AccountSid: 'ACaaaa',
      CallSid: 'CA-child',
      Digits: '9',
    });

    expect(res.text).toContain('<Hangup/>');
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('a failure while recording the acceptance still connects the human (never drop the call)', async () => {
    const cache = new WhisperCache();
    cache.set('esc_s', 'Emergency call.', TENANT_A, { sessionId: 'sess-1' });
    const onAccepted = vi.fn(() => {
      throw new Error('store exploded');
    });
    const res = await signed(build(cache, { onAccepted }), '/api/telephony/whisper/esc_s/accept', {
      AccountSid: 'ACaaaa',
      CallSid: 'CA-child',
      Digits: '1',
    });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response/>');
  });

  it('the accept action is signature-verified like the whisper itself', async () => {
    const cache = new WhisperCache();
    cache.set('esc_s', 'Emergency call.', TENANT_A, { sessionId: 'sess-1' });
    const onAccepted = vi.fn(async () => undefined);
    const app = build(cache, { onAccepted });

    const unsigned = await request(app)
      .post('/api/telephony/whisper/esc_s/accept')
      .type('form')
      .send({ AccountSid: 'ACaaaa', Digits: '1' });
    expect(unsigned.status).toBe(403);
    const forged = await signed(app, '/api/telephony/whisper/esc_s/accept', { AccountSid: 'ACaaaa', Digits: '1' }, 'wrong');
    expect(forged.status).toBe(403);
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it("another tenant's credential cannot accept this tenant's escalation", async () => {
    const cache = new WhisperCache();
    cache.set('esc_s', 'Emergency call.', TENANT_B, { sessionId: 'sess-b' });
    const onAccepted = vi.fn(async () => undefined);
    // The getter verifies as TENANT_A; the escalation belongs to TENANT_B.
    const res = await signed(build(cache, { onAccepted }), '/api/telephony/whisper/esc_s/accept', {
      AccountSid: 'ACaaaa',
      Digits: '1',
    });

    expect(res.status).toBe(200); // never a 403 on the live leg
    expect(onAccepted).not.toHaveBeenCalled();
  });
});
