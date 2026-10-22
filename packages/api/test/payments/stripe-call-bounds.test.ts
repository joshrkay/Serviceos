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
  createTerminalSession,
  ensureTerminalLocation,
  fetchConnectAccountBusinessAddress,
} from '../../src/payments/stripe-terminal';
import { createSetupIntent, retrievePaymentMethod } from '../../src/payments/stripe-saved-card';
import type { StripeFetch } from '../../src/payments/stripe-payment-intent';
import { fakeStripe } from '../helpers/fake-stripe';
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
      run: () => createPaymentIntent(config, { amount: 5000, currency: 'usd', invoiceId: 'inv_1', tenantId: TENANT, repricingNonce: 1 }),
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
          amount: 5000, currency: 'usd', tenantId: TENANT, purpose: 'invoice', invoiceId: 'inv_1', repricingNonce: 1,
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
  beforeEach(() => useProviderClock());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Stripe with documented idempotency; the first customer create can be slow or fail. */
  function stripeForCardSetup(firstCustomer: { status?: number; delayMs?: number } = {}) {
    let n = 0;
    return fakeStripe((call) => {
      if (call.path === '/v1/customers') {
        n += 1;
        if (n === 1 && firstCustomer.status) return { status: firstCustomer.status, body: { error: { message: 'boom' } } };
        return { body: { id: `cus_${n}` }, delayMs: n === 1 ? firstCustomer.delayMs : undefined };
      }
      return { body: { id: 'seti_1', client_secret: 'seti_1_secret' } };
    });
  }
  const setup = (customerId: string, stripeAccountId?: string, fetcher?: StripeFetch) =>
    createSetupIntent(
      { apiKey: 'sk_test', stripeAccountId },
      { tenantId: TENANT, customerId, email: 'pat@x.com', name: 'Pat' },
      fetcher,
    );

  it('a card setup whose customer create answer was lost is retried onto the same Stripe customer', async () => {
    const stripe = stripeForCardSetup({ delayMs: 15_000 });
    vi.stubGlobal('fetch', stripe.fetchFn);

    const first = await settleWithin(setup('c_1', 'acct_t'), 15_000);
    const retry = await settleWithin(setup('c_1', 'acct_t'), 0);

    expect(first.status).toBe('rejected');
    expect(retry).toMatchObject({ status: 'fulfilled', value: { stripeCustomerId: 'cus_1' } });
    expect(stripe.executedOn('POST', '/v1/customers')).toHaveLength(1);
    expect(stripe.executedOn('POST', '/v1/customers')[0].key).toMatch(
      new RegExp(`^customer:${TENANT}:saved-card:c_1:acct_t:`),
    );
  });

  it('a Stripe error on the customer create does not stick to the next card setup', async () => {
    const stripe = stripeForCardSetup({ status: 500 });
    vi.stubGlobal('fetch', stripe.fetchFn);

    const first = await settleWithin(setup('c_1', 'acct_t'), 0);
    const retry = await settleWithin(setup('c_1', 'acct_t'), 0);

    expect(first.status).toBe('rejected');
    expect(retry).toMatchObject({ status: 'fulfilled', value: { stripeCustomerId: 'cus_2' } });
  });

  it('another customer, or another connected account, gets a different key', async () => {
    const stripe = stripeForCardSetup();
    const fetcher = stripe.fetchFn as unknown as StripeFetch;
    await setup('c_1', 'acct_t', fetcher);
    await setup('c_2', 'acct_t', fetcher);
    await setup('c_1', undefined, fetcher);

    const [base, otherCustomer, platform] = stripe.executedOn('POST', '/v1/customers').map((c) => c.key);
    expect(base).toBeDefined();
    expect(otherCustomer).not.toBe(base);
    expect(platform).not.toBe(base);
  });
});

describe('createTerminalSession — the Terminal location create is idempotent per connected account', () => {
  beforeEach(() => useProviderClock());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a session retried after a lost location-create answer reuses the same location (no pile-up)', async () => {
    let locations = 0;
    const stripe = fakeStripe((call) => {
      if (call.path === '/v1/accounts/acct_t') {
        return { body: { company: { address: { line1: '1 Main', city: 'Phoenix', postal_code: '85001', country: 'US' } } } };
      }
      if (call.path === '/v1/terminal/locations') {
        locations += 1;
        return { body: { id: `tml_${locations}` }, delayMs: locations === 1 ? 15_000 : undefined };
      }
      return { body: { secret: 'pst_secret' } };
    });
    vi.stubGlobal('fetch', stripe.fetchFn);
    const session = () => createTerminalSession(terminal, { displayName: 'Van 1' });

    const first = await settleWithin(session(), 15_000); // gave up at 10 s; Stripe made the location at 15 s
    const retry = await settleWithin(session(), 0);

    expect(first.status).toBe('rejected');
    expect(retry).toMatchObject({ status: 'fulfilled', value: { locationId: 'tml_1' } });
    expect(stripe.executedOn('POST', '/v1/terminal/locations')).toHaveLength(1);
  });
});
