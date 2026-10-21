/**
 * S5a-3 (U8) — a deactivated pay link can carry a customer-facing inactive
 * message ("{business} collects payment in person …"). It travels in the SAME
 * Stripe update as `active=false`; if Stripe refuses the field (owner
 * decision §5.3: an account API version without it) the provider retries
 * once without it so the link still dies. The mock provider records every
 * deactivation for test fakes.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { StripePaymentLinkProvider } from '../../src/payments/stripe-payment-link';
import { MockPaymentLinkProvider } from '../../src/payments/payment-link-provider';

type Captured = { url: string; body: URLSearchParams; headers: Record<string, string> };

function stubStripe(responses: Array<{ status: number; body: string }>): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body?: URLSearchParams; headers?: Record<string, string> }) => {
      calls.push({ url, body: new URLSearchParams(init.body?.toString() ?? ''), headers: init.headers ?? {} });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        json: async () => JSON.parse(next.body),
        text: async () => next.body,
      } as unknown as Response;
    }),
  );
  return calls;
}

const provider = () => new StripePaymentLinkProvider({ apiKey: 'sk_test_x', webhookSecret: 'whsec_x' });
const MESSAGE = 'Acme HVAC collects payment in person. Please settle up with Dana when the work is done.';

describe('StripePaymentLinkProvider.deactivateLink — inactive message', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends inactive_message in the same update as active=false', async () => {
    const calls = stubStripe([{ status: 200, body: '{"id":"plink_1","active":false}' }]);
    await provider().deactivateLink('plink_1', 'acct_1', { inactiveMessage: MESSAGE });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.stripe.com/v1/payment_links/plink_1');
    expect(calls[0].body.get('active')).toBe('false');
    expect(calls[0].body.get('inactive_message')).toBe(MESSAGE);
    expect(calls[0].headers['Stripe-Account']).toBe('acct_1');
  });

  it('without a message the body is exactly today\'s active=false', async () => {
    const calls = stubStripe([{ status: 200, body: '{}' }]);
    await provider().deactivateLink('plink_2');
    expect([...calls[0].body.keys()]).toEqual(['active']);
  });

  it('a 400 that names inactive_message retries once without it, and the link still dies', async () => {
    const calls = stubStripe([
      {
        status: 400,
        body: '{"error":{"type":"invalid_request_error","param":"inactive_message","message":"Received unknown parameter: inactive_message"}}',
      },
      { status: 200, body: '{}' },
    ]);
    await provider().deactivateLink('plink_3', undefined, { inactiveMessage: MESSAGE });
    expect(calls).toHaveLength(2);
    expect(calls[0].body.get('inactive_message')).toBe(MESSAGE);
    expect(calls[1].body.get('inactive_message')).toBeNull();
    expect(calls[1].body.get('active')).toBe('false');
  });

  it('any other failure throws without a retry (the caller audits it)', async () => {
    const calls = stubStripe([{ status: 404, body: '{"error":{"code":"resource_missing"}}' }]);
    await expect(
      provider().deactivateLink('plink_4', 'acct_x', { inactiveMessage: MESSAGE }),
    ).rejects.toThrow(/Stripe deactivation failed \(404\)/);
    expect(calls).toHaveLength(1);
  });

  it('a retry that also fails throws', async () => {
    const calls = stubStripe([
      { status: 400, body: '{"error":{"param":"inactive_message"}}' },
      { status: 500, body: 'upstream' },
    ]);
    await expect(
      provider().deactivateLink('plink_5', undefined, { inactiveMessage: MESSAGE }),
    ).rejects.toThrow(/Stripe deactivation failed \(500\)/);
    expect(calls).toHaveLength(2);
  });
});

describe('MockPaymentLinkProvider — deactivation log', () => {
  it('records each deactivation with its scope and inactive message', async () => {
    const mock = new MockPaymentLinkProvider();
    const link = await mock.generateLink({ tenantId: 't', invoiceId: 'i', amountCents: 100, currency: 'usd' });
    await mock.deactivateLink(link.linkId, 'acct_9', { inactiveMessage: MESSAGE });
    await mock.deactivateLink('plink_other');
    expect(mock.isActive(link.linkId)).toBe(false);
    expect(mock.deactivations).toEqual([
      { linkId: link.linkId, stripeAccountId: 'acct_9', inactiveMessage: MESSAGE },
      { linkId: 'plink_other', stripeAccountId: undefined, inactiveMessage: undefined },
    ]);
  });
});
