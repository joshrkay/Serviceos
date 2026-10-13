/**
 * The platform fetch (undici) rejects any GET/HEAD that carries a body — even
 * an empty string — with `TypeError: Request with GET/HEAD method cannot have
 * body.` before a byte leaves the process. Two Stripe reads sent `body: ''`,
 * so in production they could never succeed: saved cards were stored without
 * brand/last4, and a Terminal session for an account with no stored location
 * always failed reading the business address.
 */
import { describe, expect, it, vi } from 'vitest';
import { retrievePaymentMethod } from '../../src/payments/stripe-saved-card';
import { fetchConnectAccountBusinessAddress } from '../../src/payments/stripe-terminal';
import { fakeJson } from '../helpers/hanging-fetch';

/** A fetch that enforces undici's GET/HEAD-without-body rule. */
function platformLikeFetch(answer: unknown) {
  return vi.fn(async (_url: string, init?: { method?: string; body?: unknown }) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if ((method === 'GET' || method === 'HEAD') && init?.body !== undefined && init?.body !== null) {
      throw new TypeError('Request with GET/HEAD method cannot have body.');
    }
    return fakeJson(answer);
  });
}

describe('Stripe reads are sent as plain GETs', () => {
  it('retrievePaymentMethod returns the saved card brand and last4', async () => {
    const fetchFn = platformLikeFetch({
      id: 'pm_1',
      card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
    });

    const card = await retrievePaymentMethod({ apiKey: 'sk_test', stripeAccountId: 'acct_1' }, 'pm_1', fetchFn);

    expect(card).toEqual({ id: 'pm_1', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 });
  });

  it('fetchConnectAccountBusinessAddress returns the connected account business address', async () => {
    const fetchFn = platformLikeFetch({
      company: {
        address: { line1: '1 Main St', line2: 'Suite 2', city: 'Phoenix', state: 'AZ', postal_code: '85001', country: 'US' },
      },
    });

    const address = await fetchConnectAccountBusinessAddress('sk_test', 'acct_1', fetchFn);

    expect(address).toEqual({
      line1: '1 Main St',
      line2: 'Suite 2',
      city: 'Phoenix',
      state: 'AZ',
      postalCode: '85001',
      country: 'US',
    });
  });
});
