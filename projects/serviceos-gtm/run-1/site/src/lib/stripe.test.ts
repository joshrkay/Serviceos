import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  encodeStripeForm,
  assertTestModeKey,
  createCheckoutSession,
  verifyWebhookSignature,
  signPayload,
  LIVE_KEY_BLOCKED_MESSAGE,
  hasStripeKey,
} from './stripe';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('encodeStripeForm', () => {
  it('encodes nested arrays and objects with bracket notation', () => {
    const params = encodeStripeForm({
      mode: 'subscription',
      line_items: [{ price: 'price_x', quantity: 1 }],
      subscription_data: { trial_period_days: 14, metadata: { plan: 'shop' } },
    });
    expect(params.get('mode')).toBe('subscription');
    expect(params.get('line_items[0][price]')).toBe('price_x');
    expect(params.get('line_items[0][quantity]')).toBe('1');
    expect(params.get('subscription_data[trial_period_days]')).toBe('14');
    expect(params.get('subscription_data[metadata][plan]')).toBe('shop');
  });
});

describe('test-mode guardrail', () => {
  it('throws the guardrail message for an sk_live key', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc123';
    expect(() => assertTestModeKey()).toThrowError(LIVE_KEY_BLOCKED_MESSAGE);
  });

  it('accepts an sk_test key', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
    expect(assertTestModeKey()).toBe('sk_test_abc123');
  });

  it('throws when no key is configured', () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(hasStripeKey()).toBe(false);
    expect(() => assertTestModeKey()).toThrow();
  });
});

describe('createCheckoutSession', () => {
  it('sends trial_period_days=14 and the given price id, and refuses live keys', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      // Assertions on the outbound Stripe request.
      expect(body).toContain('mode=subscription');
      expect(body).toContain('subscription_data%5Btrial_period_days%5D=14');
      expect(body).toContain('line_items%5B0%5D%5Bprice%5D=price_shop_123');
      expect(body).toContain('customer_email=op%40example.com');
      return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/x' }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = await createCheckoutSession({
      priceId: 'price_shop_123',
      customerEmail: 'op@example.com',
      successUrl: 'https://site/success',
      cancelUrl: 'https://site/cancel',
      metadata: { plan: 'shop', vertical: 'HVAC', business_name: 'Acme' },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(session).toEqual({ id: 'cs_test_1', url: 'https://checkout.stripe.com/x' });
  });

  it('throws (before any fetch) when a live key is present', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_nope';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createCheckoutSession({
        priceId: 'price_shop_123',
        customerEmail: 'op@example.com',
        successUrl: 'https://site/success',
        cancelUrl: 'https://site/cancel',
        metadata: {},
      }),
    ).rejects.toThrow(LIVE_KEY_BLOCKED_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('webhook signature verification', () => {
  const secret = 'whsec_test_secret';
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });

  it('accepts a correctly signed payload', () => {
    const header = signPayload(payload, secret);
    expect(verifyWebhookSignature({ payload, signatureHeader: header, secret })).toEqual({
      valid: true,
    });
  });

  it('rejects a tampered payload', () => {
    const header = signPayload(payload, secret);
    const result = verifyWebhookSignature({
      payload: payload + 'tamper',
      signatureHeader: header,
      secret,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature mismatch');
  });

  it('rejects a wrong secret', () => {
    const header = signPayload(payload, secret);
    const result = verifyWebhookSignature({ payload, signatureHeader: header, secret: 'whsec_wrong' });
    expect(result.valid).toBe(false);
  });

  it('rejects a missing header', () => {
    const result = verifyWebhookSignature({ payload, signatureHeader: null, secret });
    expect(result).toMatchObject({ valid: false, reason: 'missing signature header' });
  });

  it('rejects a malformed header', () => {
    const result = verifyWebhookSignature({ payload, signatureHeader: 'garbage', secret });
    expect(result.valid).toBe(false);
  });

  it('enforces the timestamp tolerance window', () => {
    const oldTs = Math.floor(Date.now() / 1000) - 10_000;
    const header = signPayload(payload, secret, oldTs);
    const result = verifyWebhookSignature({
      payload,
      signatureHeader: header,
      secret,
      toleranceSeconds: 300,
    });
    expect(result).toMatchObject({ valid: false, reason: 'timestamp outside tolerance' });
  });

  it('honors an explicit nowSeconds for deterministic checks', () => {
    const ts = 1_700_000_000;
    const header = signPayload(payload, secret, ts);
    const result = verifyWebhookSignature({
      payload,
      signatureHeader: header,
      secret,
      nowSeconds: ts + 5,
    });
    expect(result.valid).toBe(true);
  });
});
