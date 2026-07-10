/**
 * Money-movement regression: a Stripe Payment Link must be single-use so a
 * replayed/saved link cannot double-charge a card after the invoice is settled.
 * Asserts the payment_links POST carries restrictions[completed_sessions][limit]=1.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { StripePaymentLinkProvider } from '../../src/payments/stripe-payment-link';

describe('StripePaymentLinkProvider — single completed checkout restriction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sets restrictions[completed_sessions][limit]=1 on the payment_links POST', async () => {
    let capturedBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body?: URLSearchParams }) => {
        capturedBody = init.body ? init.body.toString() : '';
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'plink_test_1', url: 'https://pay.stripe.com/x' }),
          text: async () => '',
        } as unknown as Response;
      }),
    );

    const provider = new StripePaymentLinkProvider({ apiKey: 'sk_test_x', webhookSecret: 'whsec_x' });
    const result = await provider.generateLink({
      tenantId: 't1',
      invoiceId: 'inv1',
      amountCents: 12500,
      currency: 'usd',
    });

    expect(result.linkUrl).toBe('https://pay.stripe.com/x');
    // Stripe itself will refuse a second completed checkout on this link.
    const params = new URLSearchParams(capturedBody);
    expect(params.get('restrictions[completed_sessions][limit]')).toBe('1');
  });
});
