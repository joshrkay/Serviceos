import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { verifyTwilioSignature } from '../src/modules/comms/inbound';
import { verifyHmacSignature, verifyStripeSignature } from '../src/modules/webhooks/base';

describe('stripe signature verification', () => {
  const secret = 'whsec_test';

  function sign(body: string, timestampSeconds: number): string {
    const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
    return `t=${timestampSeconds},v1=${mac}`;
  }

  it('accepts a valid signature within tolerance', () => {
    const body = '{"id":"evt_1"}';
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyStripeSignature(secret, body, sign(body, ts))).toBe(true);
  });

  it('rejects stale timestamps (replay protection)', () => {
    const body = '{"id":"evt_1"}';
    const ts = Math.floor(Date.now() / 1000) - 3600;
    expect(verifyStripeSignature(secret, body, sign(body, ts))).toBe(false);
  });

  it('rejects tampered bodies and garbage headers (fuzzed)', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (body, tampered) => {
        const ts = Math.floor(Date.now() / 1000);
        const header = sign(body, ts);
        if (tampered !== body) {
          expect(verifyStripeSignature(secret, tampered, header)).toBe(false);
        }
        expect(verifyStripeSignature(secret, body, tampered)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });
});

describe('twilio signature verification', () => {
  const token = 'twilio_auth_token';
  const url = 'https://api.example.test/webhooks/twilio/sms';

  function sign(params: Record<string, string>): string {
    const data = Object.keys(params)
      .sort()
      .reduce((acc, key) => acc + key + params[key], url);
    return createHmac('sha1', token).update(data).digest('base64');
  }

  it('accepts valid signatures and rejects parameter tampering (fuzzed)', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.stringMatching(/^[A-Za-z]{1,10}$/), fc.string({ maxLength: 50 }), {
          minKeys: 1,
          maxKeys: 8,
        }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (params, injected) => {
          const signature = sign(params);
          expect(verifyTwilioSignature(token, url, params, signature)).toBe(true);
          const tampered = { ...params, Body: (params.Body ?? '') + injected };
          expect(verifyTwilioSignature(token, url, tampered, signature)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('generic hmac verification', () => {
  it('never accepts a signature produced with a different secret (fuzzed)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), fc.string(), (a, b, body) => {
        fc.pre(a !== b);
        const signature = createHmac('sha256', a).update(body).digest('hex');
        expect(verifyHmacSignature(b, body, signature)).toBe(false);
        expect(verifyHmacSignature(a, body, signature)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
