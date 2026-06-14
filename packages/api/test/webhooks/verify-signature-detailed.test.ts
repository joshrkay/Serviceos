import { describe, it, expect } from 'vitest';
import {
  verifyWebhookSignature,
  verifyWebhookSignatureDetailed,
  createWebhookSignature,
} from '../../src/webhooks/webhook-handler';
import { parseStripeEventEnvelope } from '../../src/webhooks/routes';

const secret = 'whsec_detailed_test';

describe('EC-11/EC-18 — verifyWebhookSignatureDetailed reports a distinct reason', () => {
  it('ok on a valid, recent signature', () => {
    const payload = JSON.stringify({ a: 1 });
    const sig = createWebhookSignature(payload, secret);
    expect(verifyWebhookSignatureDetailed(payload, sig, secret)).toEqual({ ok: true });
  });

  it('distinguishes a stale timestamp from a forged signature', () => {
    const payload = JSON.stringify({ a: 1 });
    // A signature that is VALID for an old timestamp → stale, not a mismatch.
    const staleSig = createWebhookSignature(payload, secret, Math.floor(Date.now() / 1000) - 600);
    const stale = verifyWebhookSignatureDetailed(payload, staleSig, secret, 300);
    expect(stale).toEqual({ ok: false, reason: 'stale_timestamp' });

    // A recent timestamp with the wrong HMAC (signed with another secret) → mismatch.
    const forgedSig = createWebhookSignature(payload, 'a_different_secret');
    const forged = verifyWebhookSignatureDetailed(payload, forgedSig, secret);
    expect(forged).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('reports malformed header, malformed timestamp, and missing input', () => {
    const payload = 'p';
    expect(verifyWebhookSignatureDetailed(payload, 't=123', secret)).toEqual({
      ok: false,
      reason: 'malformed_header',
    });
    expect(verifyWebhookSignatureDetailed(payload, 't=notanumber,v1=deadbeef', secret)).toEqual({
      ok: false,
      reason: 'malformed_timestamp',
    });
    expect(verifyWebhookSignatureDetailed('', 'sig', secret)).toEqual({
      ok: false,
      reason: 'missing_input',
    });
  });

  it('the boolean wrapper stays in lockstep with the detailed result', () => {
    const payload = JSON.stringify({ a: 1 });
    const good = createWebhookSignature(payload, secret);
    expect(verifyWebhookSignature(payload, good, secret)).toBe(true);
    expect(verifyWebhookSignature(payload, 't=123,v1=bad', secret)).toBe(false);
  });
});

describe('EC-17 — parseStripeEventEnvelope validates the event envelope', () => {
  it('accepts a well-formed envelope and preserves passthrough fields', () => {
    const raw = JSON.stringify({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_1' } },
      account: 'acct_1',
    });
    const result = parseStripeEventEnvelope(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.id).toBe('evt_1');
      expect(result.event.type).toBe('payment_intent.succeeded');
      expect((result.event.data.object as { id: string }).id).toBe('pi_1');
      // .passthrough() keeps extra Stripe fields the handler may read.
      expect((result.event as { account?: string }).account).toBe('acct_1');
    }
  });

  it('rejects invalid JSON', () => {
    expect(parseStripeEventEnvelope('not json')).toEqual({ ok: false, error: 'Invalid JSON body' });
  });

  it('rejects a payload missing data.object or id/type', () => {
    expect(parseStripeEventEnvelope(JSON.stringify({ id: 'evt_1', type: 'x', data: {} }))).toEqual({
      ok: false,
      error: 'Invalid Stripe event payload',
    });
    expect(parseStripeEventEnvelope(JSON.stringify({ type: 'x', data: { object: {} } }))).toEqual({
      ok: false,
      error: 'Invalid Stripe event payload',
    });
    expect(parseStripeEventEnvelope(JSON.stringify({ id: 'evt_1', data: { object: {} } }))).toEqual({
      ok: false,
      error: 'Invalid Stripe event payload',
    });
  });
});
