import { describe, it, expect, vi, type MockedFunction } from 'vitest';
import {
  createTerminalConnectionToken,
  createTerminalPaymentIntent,
} from '../../src/payments/stripe-terminal';
import type { StripeFetch } from '../../src/payments/stripe-payment-intent';

function makeOkFetcher(bodyJson: unknown): MockedFunction<StripeFetch> {
  const spy = vi.fn() as MockedFunction<StripeFetch>;
  spy.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => bodyJson,
  });
  return spy;
}

describe('stripe-terminal', () => {
  const config = { apiKey: 'sk_test', stripeAccountId: 'acct_field_1' };

  it('createTerminalConnectionToken sends Stripe-Account header', async () => {
    const spy = makeOkFetcher({ secret: 'pst_test_secret' });
    const result = await createTerminalConnectionToken(config, spy);
    expect(result.secret).toBe('pst_test_secret');
    const [url, init] = spy.mock.calls[0];
    expect(url).toContain('/v1/terminal/connection_tokens');
    expect(init.headers['Stripe-Account']).toBe('acct_field_1');
  });

  it('createTerminalPaymentIntent uses card_present only and Connect header', async () => {
    const spy = makeOkFetcher({ id: 'pi_term_1', client_secret: 'pi_term_1_secret' });
    const result = await createTerminalPaymentIntent(
      config,
      {
        amount: 9900,
        currency: 'usd',
        tenantId: 'tenant-1',
        invoiceId: '11111111-1111-4111-8111-111111111111',
        purpose: 'invoice',
      },
      spy,
    );
    expect(result.paymentIntentId).toBe('pi_term_1');
    const [, init] = spy.mock.calls[0];
    expect(init.headers['Stripe-Account']).toBe('acct_field_1');
    expect(init.headers['Idempotency-Key']).toContain('acct_field_1');
    expect(init.body).toContain('payment_method_types');
    expect(init.body).toContain('card_present');
    expect(init.body).not.toContain('automatic_payment_methods');
    expect(init.body).toContain('invoice_id');
  });

  it('rejects missing Connect account id', async () => {
    await expect(
      createTerminalConnectionToken({ apiKey: 'sk_test', stripeAccountId: '' }),
    ).rejects.toThrow(/stripeAccountId/);
  });

  it('rejects non-positive amount', async () => {
    await expect(
      createTerminalPaymentIntent(config, {
        amount: 0,
        currency: 'usd',
        tenantId: 't1',
        invoiceId: '11111111-1111-4111-8111-111111111111',
        purpose: 'invoice',
      }),
    ).rejects.toThrow(/positive integer/);
  });
});
