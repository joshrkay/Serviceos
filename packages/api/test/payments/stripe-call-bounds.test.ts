/**
 * Reliability #5 — the fetch-based Stripe wrappers (PaymentIntents, Terminal,
 * saved cards) run on public pay pages and in-app request handlers. Called
 * without an injected fetcher (production), each call is bounded at 10 s and
 * fails the way a network failure does (the fetch rejection propagates).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelPaymentIntent,
  createPaymentIntent,
  searchPaymentIntentsByInvoice,
} from '../../src/payments/stripe-payment-intent';
import {
  createTerminalConnectionToken,
  createTerminalPaymentIntent,
  ensureTerminalLocation,
  fetchConnectAccountBusinessAddress,
} from '../../src/payments/stripe-terminal';
import { createSetupIntent, retrievePaymentMethod } from '../../src/payments/stripe-saved-card';
import { fakeJson, hangingFetch, settleWithin, useProviderClock } from '../helpers/hanging-fetch';

const TENANT = '55555555-5555-4555-8555-555555555555';
const config = { apiKey: 'sk_test' };
const terminal = { apiKey: 'sk_test', stripeAccountId: 'acct_t' };
const address = { line1: '1 Main', city: 'Phoenix', postalCode: '85001', country: 'US' };

describe('Stripe payment wrappers — bounded when no fetcher is passed', () => {
  beforeEach(() => useProviderClock());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each<{ name: string; hangOn: string; run: () => Promise<unknown> }>([
    {
      name: 'PaymentIntent create',
      hangOn: '/v1/payment_intents',
      run: () => createPaymentIntent(config, { amount: 5000, currency: 'usd', invoiceId: 'inv_1', tenantId: TENANT }),
    },
    {
      name: 'PaymentIntent search',
      hangOn: '/v1/payment_intents/search',
      run: () => searchPaymentIntentsByInvoice(config, { tenantId: TENANT, invoiceId: 'inv_1' }),
    },
    {
      name: 'PaymentIntent cancel',
      hangOn: '/v1/payment_intents/pi_1/cancel',
      run: () => cancelPaymentIntent(config, 'pi_1'),
    },
    {
      name: 'Terminal location create',
      hangOn: '/v1/terminal/locations',
      run: () => ensureTerminalLocation(terminal, { displayName: 'Van', address }),
    },
    {
      name: 'Connect business-address read',
      hangOn: '/v1/accounts/acct_t',
      run: () => fetchConnectAccountBusinessAddress('sk_test', 'acct_t'),
    },
    {
      name: 'Terminal connection token',
      hangOn: '/v1/terminal/connection_tokens',
      run: () => createTerminalConnectionToken(terminal),
    },
    {
      name: 'Terminal PaymentIntent create',
      hangOn: '/v1/payment_intents',
      run: () =>
        createTerminalPaymentIntent(terminal, {
          amount: 5000, currency: 'usd', tenantId: TENANT, purpose: 'invoice', invoiceId: 'inv_1',
        }),
    },
    {
      name: 'saved-card customer create',
      hangOn: '/v1/customers',
      run: () => createSetupIntent(config, { tenantId: TENANT, customerId: 'c_1' }),
    },
    {
      name: 'saved-card SetupIntent create',
      hangOn: '/v1/setup_intents',
      run: () => createSetupIntent(config, { tenantId: TENANT, customerId: 'c_1', stripeCustomerId: 'cus_1' }),
    },
    {
      name: 'saved-card PaymentMethod read',
      hangOn: '/v1/payment_methods/pm_1',
      run: () => retrievePaymentMethod(config, 'pm_1'),
    },
  ])('$name times out at 10 s like a network failure', async ({ hangOn, run }) => {
    const fetchMock = hangingFetch((url) => url.split('?')[0].endsWith(hangOn), () => fakeJson({ id: 'cus_1' }));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await settleWithin(run(), 10_000);

    expect(fetchMock.mock.calls.some(([url]) => String(url).split('?')[0].endsWith(hangOn))).toBe(true);
    expect(outcome.status).toBe('rejected');
    expect((outcome as { reason: Error }).reason.name).toBe('TimeoutError');
  });
});

describe('createSetupIntent — the Stripe customer create is idempotent per customer', () => {
  /** The customer create succeeded at Stripe but its response was lost. */
  const lostCustomerCreate = () =>
    vi.fn(async (input: string) =>
      input.endsWith('/v1/customers') ? fakeJson({ error: { message: 'lost' } }, 500) : fakeJson({}),
    );
  const customerKeys = (fetchFn: ReturnType<typeof lostCustomerCreate>) =>
    fetchFn.mock.calls
      .filter(([url]) => url.endsWith('/v1/customers'))
      .map(([, init]) => (init as { headers: Record<string, string> }).headers['Idempotency-Key']);
  const setup = (fetchFn: ReturnType<typeof lostCustomerCreate>, customerId: string, stripeAccountId?: string) =>
    createSetupIntent(
      { apiKey: 'sk_test', stripeAccountId },
      { tenantId: TENANT, customerId, email: 'pat@x.com', name: 'Pat' },
      fetchFn,
    ).catch(() => undefined);

  it('a retried card setup sends the same Idempotency-Key, scoped to the tenant and customer', async () => {
    const fetchFn = lostCustomerCreate();
    await setup(fetchFn, 'c_1', 'acct_t');
    await setup(fetchFn, 'c_1', 'acct_t');

    const [first, retry] = customerKeys(fetchFn);
    expect(first).toMatch(new RegExp(`^customer:${TENANT}:saved-card:c_1:`));
    expect(retry).toBe(first);
  });

  it('another customer, or another connected account, gets a different key', async () => {
    const fetchFn = lostCustomerCreate();
    await setup(fetchFn, 'c_1', 'acct_t');
    await setup(fetchFn, 'c_2', 'acct_t');
    await setup(fetchFn, 'c_1', undefined);

    const [base, otherCustomer, platform] = customerKeys(fetchFn);
    expect(base).toBeDefined();
    expect(otherCustomer).not.toBe(base);
    expect(platform).not.toBe(base);
  });
});
