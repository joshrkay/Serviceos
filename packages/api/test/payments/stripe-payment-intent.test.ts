import { describe, it, expect, vi, type MockedFunction } from 'vitest';
import {
  cancelPaymentIntent,
  createPaymentIntent,
  searchPaymentIntentsByInvoice,
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

  it('uses an idempotency key derived from invoiceId+amount+platform', async () => {
    const spy = vi.fn() as MockedFunction<StripeFetch>;
    spy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ id: 'pi_1', client_secret: 'pi_1_secret_xyz' }),
    });
    await createPaymentIntent({ apiKey: 'sk_test' }, validInput, spy);
    const [, init] = spy.mock.calls[0];
    expect(init.headers['Idempotency-Key']).toBe('pi_inv-1_12500_platform');
    expect(init.headers['Stripe-Account']).toBeUndefined();
  });

  it('sets Stripe-Account and scopes idempotency when stripeAccountId is set', async () => {
    const spy = vi.fn() as MockedFunction<StripeFetch>;
    spy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ id: 'pi_connect', client_secret: 'pi_connect_secret' }),
    });
    await createPaymentIntent(
      { apiKey: 'sk_test' },
      { ...validInput, stripeAccountId: 'acct_tenant_1' },
      spy,
    );
    const [, init] = spy.mock.calls[0];
    expect(init.headers['Stripe-Account']).toBe('acct_tenant_1');
    expect(init.headers['Idempotency-Key']).toBe('pi_inv-1_12500_acct_tenant_1');
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

describe('P0-1 completion — searchPaymentIntentsByInvoice', () => {
  const input = { tenantId: 'tenant-1', invoiceId: 'inv-1' };

  it('queries the search endpoint on invoice_id + tenant_id metadata and returns id/status', async () => {
    const spy = vi.fn() as MockedFunction<StripeFetch>;
    spy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        data: [
          { id: 'pi_a', status: 'requires_payment_method' },
          { id: 'pi_b', status: 'succeeded' },
        ],
        has_more: false,
      }),
    });

    const result = await searchPaymentIntentsByInvoice({ apiKey: 'sk_test' }, input, spy);

    expect(result).toEqual([
      { id: 'pi_a', status: 'requires_payment_method' },
      { id: 'pi_b', status: 'succeeded' },
    ]);
    const [url, init] = spy.mock.calls[0];
    expect(url).toContain('https://api.stripe.com/v1/payment_intents/search?');
    const query = new URL(url).searchParams.get('query');
    expect(query).toBe("metadata['invoice_id']:'inv-1' AND metadata['tenant_id']:'tenant-1'");
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer sk_test');
    expect(init.headers['Stripe-Account']).toBeUndefined();
  });

  it('sets Stripe-Account when scoped to a Connect account', async () => {
    const spy = vi.fn() as MockedFunction<StripeFetch>;
    spy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ data: [], has_more: false }),
    });
    await searchPaymentIntentsByInvoice(
      { apiKey: 'sk_test' },
      { ...input, stripeAccountId: 'acct_tenant_1' },
      spy,
    );
    const [, init] = spy.mock.calls[0];
    expect(init.headers['Stripe-Account']).toBe('acct_tenant_1');
  });

  it('follows next_page until has_more is false', async () => {
    const spy = vi.fn() as MockedFunction<StripeFetch>;
    spy
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          data: [{ id: 'pi_1', status: 'requires_action' }],
          has_more: true,
          next_page: 'cursor_2',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          data: [{ id: 'pi_2', status: 'requires_action' }],
          has_more: false,
        }),
      });

    const result = await searchPaymentIntentsByInvoice({ apiKey: 'sk_test' }, input, spy);

    expect(result.map((r) => r.id)).toEqual(['pi_1', 'pi_2']);
    expect(spy).toHaveBeenCalledTimes(2);
    const secondUrl = spy.mock.calls[1][0];
    expect(new URL(secondUrl).searchParams.get('page')).toBe('cursor_2');
  });

  it('throws on a non-2xx search response', async () => {
    const fetcher: StripeFetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'search down',
      json: async () => ({}),
    });
    await expect(
      searchPaymentIntentsByInvoice({ apiKey: 'sk_test' }, input, fetcher),
    ).rejects.toThrow(/paymentIntents.search failed \(500\)/);
  });

  it('requires apiKey, invoiceId, and tenantId', async () => {
    await expect(
      searchPaymentIntentsByInvoice({ apiKey: '' }, input),
    ).rejects.toThrow(/Stripe API key/);
    await expect(
      searchPaymentIntentsByInvoice({ apiKey: 'sk_test' }, { ...input, invoiceId: '' }),
    ).rejects.toThrow(/invoiceId/);
    await expect(
      searchPaymentIntentsByInvoice({ apiKey: 'sk_test' }, { ...input, tenantId: '' }),
    ).rejects.toThrow(/tenantId/);
  });
});

describe('P0-1 completion — cancelPaymentIntent', () => {
  it('POSTs to /v1/payment_intents/:id/cancel with auth (platform scope)', async () => {
    const spy = vi.fn() as MockedFunction<StripeFetch>;
    spy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ id: 'pi_x', status: 'canceled' }),
    });

    await cancelPaymentIntent({ apiKey: 'sk_test' }, 'pi_x', undefined, spy);

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/payment_intents/pi_x/cancel');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk_test');
    expect(init.headers['Stripe-Account']).toBeUndefined();
  });

  it('sets Stripe-Account for a Connect-minted PI', async () => {
    const spy = vi.fn() as MockedFunction<StripeFetch>;
    spy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ id: 'pi_x', status: 'canceled' }),
    });

    await cancelPaymentIntent({ apiKey: 'sk_test' }, 'pi_x', 'acct_tenant_1', spy);

    const [, init] = spy.mock.calls[0];
    expect(init.headers['Stripe-Account']).toBe('acct_tenant_1');
  });

  it('throws on a non-2xx cancel response (caller audits, never blocks the void)', async () => {
    const fetcher: StripeFetch = async () => ({
      ok: false,
      status: 400,
      text: async () => 'You cannot cancel this PaymentIntent',
      json: async () => ({}),
    });
    await expect(
      cancelPaymentIntent({ apiKey: 'sk_test' }, 'pi_done', undefined, fetcher),
    ).rejects.toThrow(/paymentIntents.cancel failed \(400\)/);
  });

  it('requires apiKey and paymentIntentId', async () => {
    await expect(cancelPaymentIntent({ apiKey: '' }, 'pi_x')).rejects.toThrow(/Stripe API key/);
    await expect(cancelPaymentIntent({ apiKey: 'sk_test' }, '')).rejects.toThrow(/paymentIntentId/);
  });
});
