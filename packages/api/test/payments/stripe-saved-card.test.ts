import { describe, it, expect } from 'vitest';
import {
  createSetupIntent,
  retrievePaymentMethod,
  chargeOffSession,
} from '../../src/payments/stripe-saved-card';
import { StripeFetch } from '../../src/payments/stripe-payment-intent';

function jsonRes(ok: boolean, status: number, body: unknown) {
  return { ok, status, text: async () => JSON.stringify(body), json: async () => body };
}

describe('createSetupIntent', () => {
  it('creates a customer then a setup intent, carrying the Connect header + metadata', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetcher: StripeFetch = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      if (url.includes('/v1/customers')) return jsonRes(true, 200, { id: 'cus_new' });
      return jsonRes(true, 200, { id: 'seti_1', client_secret: 'seti_1_secret' });
    };

    const result = await createSetupIntent(
      { apiKey: 'sk_test', stripeAccountId: 'acct_123' },
      { tenantId: 't1', customerId: 'c1', email: 'a@b.com' },
      fetcher,
    );

    expect(result).toEqual({
      clientSecret: 'seti_1_secret',
      setupIntentId: 'seti_1',
      stripeCustomerId: 'cus_new',
    });
    expect(calls[0].url).toContain('/v1/customers');
    expect(calls[0].headers['Stripe-Account']).toBe('acct_123');
    expect(calls[1].url).toContain('/v1/setup_intents');
    expect(calls[1].body).toContain('customer=cus_new');
    expect(calls[1].body).toContain('usage=off_session');
    expect(calls[1].body).toContain('metadata%5Btenant_id%5D=t1');
  });

  it('reuses an existing Stripe customer (skips customer creation)', async () => {
    const urls: string[] = [];
    const fetcher: StripeFetch = async (url) => {
      urls.push(url);
      return jsonRes(true, 200, { id: 'seti_2', client_secret: 'secret2' });
    };

    const result = await createSetupIntent(
      { apiKey: 'sk_test' },
      { tenantId: 't1', customerId: 'c1', stripeCustomerId: 'cus_existing' },
      fetcher,
    );

    expect(result.stripeCustomerId).toBe('cus_existing');
    expect(urls).toEqual(['https://api.stripe.com/v1/setup_intents']);
  });
});

describe('retrievePaymentMethod', () => {
  it('returns brand/last4/expiry', async () => {
    const fetcher: StripeFetch = async () =>
      jsonRes(true, 200, {
        id: 'pm_1',
        card: { brand: 'visa', last4: '4242', exp_month: 11, exp_year: 2031 },
      });
    const pm = await retrievePaymentMethod({ apiKey: 'sk' }, 'pm_1', fetcher);
    expect(pm).toEqual({ id: 'pm_1', brand: 'visa', last4: '4242', expMonth: 11, expYear: 2031 });
  });
});

describe('chargeOffSession', () => {
  const base = {
    amount: 5000,
    currency: 'usd',
    stripeCustomerId: 'cus',
    paymentMethodId: 'pm',
    idempotencyKey: 'k1',
  };

  it('returns succeeded with the payment-intent id', async () => {
    const fetcher: StripeFetch = async () => jsonRes(true, 200, { id: 'pi_1', status: 'succeeded' });
    const r = await chargeOffSession({ apiKey: 'sk' }, base, fetcher);
    expect(r).toEqual({ status: 'succeeded', paymentIntentId: 'pi_1' });
  });

  it('returns a structured failure on a decline (does not throw)', async () => {
    const fetcher: StripeFetch = async () =>
      jsonRes(false, 402, {
        error: {
          code: 'card_declined',
          decline_code: 'insufficient_funds',
          message: 'Your card was declined.',
          payment_intent: { id: 'pi_2', status: 'requires_payment_method' },
        },
      });
    const r = await chargeOffSession({ apiKey: 'sk' }, base, fetcher);
    expect(r.status).toBe('failed');
    expect(r.declineCode).toBe('insufficient_funds');
    expect(r.paymentIntentId).toBe('pi_2');
  });

  it('maps off-session authentication_required to requires_action', async () => {
    const fetcher: StripeFetch = async () =>
      jsonRes(false, 402, {
        error: {
          code: 'authentication_required',
          message: 'auth',
          payment_intent: { id: 'pi_3', status: 'requires_action' },
        },
      });
    const r = await chargeOffSession({ apiKey: 'sk' }, base, fetcher);
    expect(r.status).toBe('requires_action');
    expect(r.paymentIntentId).toBe('pi_3');
  });

  it('sends the idempotency key + connect header', async () => {
    let captured: Record<string, string> = {};
    const fetcher: StripeFetch = async (_url, init) => {
      captured = init.headers;
      return jsonRes(true, 200, { id: 'pi', status: 'succeeded' });
    };
    await chargeOffSession(
      { apiKey: 'sk', stripeAccountId: 'acct_9' },
      { ...base, idempotencyKey: 'idem-xyz' },
      fetcher,
    );
    expect(captured['Idempotency-Key']).toBe('idem-xyz');
    expect(captured['Stripe-Account']).toBe('acct_9');
  });
});
