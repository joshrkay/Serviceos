import { describe, it, expect, vi, type MockedFunction } from 'vitest';
import {
  createPaymentIntent,
  StripeFetch,
} from '../../src/payments/stripe-payment-intent';

function makeFetcher(
  response: { ok: boolean; status: number; bodyText?: string; bodyJson?: unknown },
  spy?: MockedFunction<StripeFetch>,
): StripeFetch {
  const fn: StripeFetch = async (_url, _init) => ({
    ok: response.ok,
    status: response.status,
    text: async () => response.bodyText ?? '',
    json: async () => response.bodyJson ?? {},
  });
  if (spy) {
    spy.mockImplementation(fn);
    return spy;
  }
  return fn;
}

describe('P5-016 stripe-payment-intent — createPaymentIntent', () => {
  const validInput = {
    amount: 12500,
    currency: 'usd',
    invoiceId: 'inv-1',
    tenantId: 'tenant-1',
  };

  it('returns clientSecret + paymentIntentId on success', async () => {
    const fetcher = makeFetcher({
      ok: true,
      status: 200,
      bodyJson: { id: 'pi_test_123', client_secret: 'pi_test_123_secret_abc' },
    });
    const result = await createPaymentIntent({ apiKey: 'sk_test' }, validInput, fetcher);
    expect(result.paymentIntentId).toBe('pi_test_123');
    expect(result.clientSecret).toBe('pi_test_123_secret_abc');
  });

  it('sends amount, currency, automatic_payment_methods, and metadata in body', async () => {
    const spy = vi.fn() as MockedFunction<StripeFetch>;
    spy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ id: 'pi_1', client_secret: 'pi_1_secret_xyz' }),
    });
    await createPaymentIntent({ apiKey: 'sk_test' }, validInput, spy);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk_test');
    expect(init.body).toContain('amount=12500');
    expect(init.body).toContain('currency=usd');
    expect(init.body).toContain('automatic_payment_methods');
    expect(init.body).toContain('invoice_id');
    expect(init.body).toContain('tenant_id');
  });

  it('uses an idempotency key derived from invoiceId+amount', async () => {
    const spy = vi.fn() as MockedFunction<StripeFetch>;
    spy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ id: 'pi_1', client_secret: 'pi_1_secret_xyz' }),
    });
    await createPaymentIntent({ apiKey: 'sk_test' }, validInput, spy);
    const [, init] = spy.mock.calls[0];
    expect(init.headers['Idempotency-Key']).toBe('pi_inv-1_12500');
  });

  it('throws when Stripe returns non-2xx', async () => {
    const fetcher = makeFetcher({ ok: false, status: 400, bodyText: 'invalid amount' });
    await expect(
      createPaymentIntent({ apiKey: 'sk_test' }, validInput, fetcher),
    ).rejects.toThrow(/Stripe paymentIntents.create failed/);
  });

  it('throws when Stripe returns no client_secret', async () => {
    const fetcher = makeFetcher({ ok: true, status: 200, bodyJson: { id: 'pi_1' } });
    await expect(
      createPaymentIntent({ apiKey: 'sk_test' }, validInput, fetcher),
    ).rejects.toThrow(/missing id or client_secret/);
  });

  it('throws when API key is empty', async () => {
    await expect(
      createPaymentIntent({ apiKey: '' }, validInput),
    ).rejects.toThrow(/Stripe API key/);
  });

  it('throws when amount is not a positive integer', async () => {
    await expect(
      createPaymentIntent({ apiKey: 'sk_test' }, { ...validInput, amount: 0 }),
    ).rejects.toThrow(/positive integer/);
    await expect(
      createPaymentIntent({ apiKey: 'sk_test' }, { ...validInput, amount: 1.5 }),
    ).rejects.toThrow(/positive integer/);
  });

  it('throws when invoiceId or tenantId is missing', async () => {
    await expect(
      createPaymentIntent({ apiKey: 'sk_test' }, { ...validInput, invoiceId: '' }),
    ).rejects.toThrow(/invoiceId/);
    await expect(
      createPaymentIntent({ apiKey: 'sk_test' }, { ...validInput, tenantId: '' }),
    ).rejects.toThrow(/tenantId/);
  });
});
