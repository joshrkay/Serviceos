/**
 * Reliability #5 / money-data #12 — the subscription and Connect services run
 * their Stripe calls inside the HTTP request transaction. A Stripe call that
 * never answers must not pin the pooled connection until the 60 s idle-tx
 * guard: with no fetch injected (production), every call is bounded at 10 s
 * and fails the same way a network failure does (the raw fetch rejection).
 *
 * Stripe requests whose response can be lost after Stripe acted (customer and
 * Express-account creates) carry an Idempotency-Key so a retry replays the
 * first object instead of minting a second one. Stripe caches a key's result
 * INCLUDING errors, so the tests below use a fake Stripe with that real replay
 * behaviour (test/helpers/fake-stripe.ts): a cached error must not stick to
 * the tenant's next attempt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingService, END_TRIAL_TIMEOUT_MS } from '../../src/billing/subscription';
import { StripeConnectService } from '../../src/billing/stripe-connect';
import { fakePool } from './fake-pool';
import {
  advance,
  fakeJson,
  hangingFetch,
  settleWithin,
  track,
  useProviderClock,
} from '../helpers/hanging-fetch';
import { fakeStripe } from '../helpers/fake-stripe';

const TENANT = '33333333-3333-4333-8333-333333333333';
const STRIPE_TIMEOUT_MS = 10_000;

function billingPool(tenant: Record<string, unknown>) {
  return fakePool((sql) => {
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('FROM tenants')) return { rows: [tenant] };
    if (sql.includes('RETURNING stripe_customer_id')) return { rows: [{ stripe_customer_id: 'cus_new' }] };
    return { rows: [] };
  });
}

function timedOut(outcome: { status: string; reason?: unknown }) {
  expect(outcome.status).toBe('rejected');
  expect((outcome.reason as Error).name).toBe('TimeoutError');
}

describe('BillingService — Stripe calls are bounded when no fetch is injected', () => {
  beforeEach(() => {
    useProviderClock();
    vi.stubEnv('STRIPE_PRICE_ID', 'price_legacy');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const cases: Array<{
    name: string;
    tenant: Record<string, unknown>;
    hangOn: string;
    /** Only this method hangs (default: any). */
    method?: string;
    /** Deadline the call must give up by (default: the 10 s Stripe bound). */
    boundMs?: number;
    run: (svc: BillingService) => Promise<unknown>;
  }> = [
    {
      name: 'billing portal: customer create',
      tenant: { stripe_customer_id: null },
      hangOn: '/v1/customers',
      run: (svc) => svc.getOrCreatePortalUrl({ tenantId: TENANT, ownerEmail: 'o@x.com', returnUrl: 'https://app/settings' }),
    },
    {
      name: 'billing portal: session create',
      tenant: { stripe_customer_id: 'cus_1' },
      hangOn: '/v1/billing_portal/sessions',
      run: (svc) => svc.getOrCreatePortalUrl({ tenantId: TENANT, ownerEmail: 'o@x.com', returnUrl: 'https://app/settings' }),
    },
    {
      name: 'trial checkout: session create',
      tenant: { stripe_customer_id: 'cus_1', subscription_status: null, pending_checkout_at: null },
      hangOn: '/v1/checkout/sessions',
      run: (svc) => svc.createTrialCheckoutSession({ tenantId: TENANT, ownerEmail: 'o@x.com', successUrl: 'https://app/ok', cancelUrl: 'https://app/no' }),
    },
    {
      name: 'trial checkout: outstanding-session lookup',
      tenant: {
        stripe_customer_id: 'cus_1',
        subscription_status: null,
        pending_checkout_at: new Date(),
        pending_checkout_session_id: 'cs_pending',
      },
      hangOn: '/v1/checkout/sessions/cs_pending',
      run: (svc) => svc.createTrialCheckoutSession({ tenantId: TENANT, ownerEmail: 'o@x.com', successUrl: 'https://app/ok', cancelUrl: 'https://app/no' }),
    },
    {
      // #1677 H1 — this update charges the card inside the request: it gets
      // the long END_TRIAL deadline instead of the 10 s default.
      name: 'end trial now (charges the card)',
      tenant: { stripe_subscription_id: 'sub_1' },
      hangOn: '/v1/subscriptions/sub_1',
      method: 'POST',
      boundMs: END_TRIAL_TIMEOUT_MS,
      run: (svc) => svc.endTrialNow(TENANT),
    },
    {
      name: 'cancel pending checkout: session expire',
      tenant: { pending_checkout_session_id: 'cs_1' },
      hangOn: '/v1/checkout/sessions/cs_1/expire',
      run: (svc) => svc.clearPendingCheckout(TENANT),
    },
  ];

  it.each(cases)('$name gives up at its deadline like a network failure', async ({ tenant, hangOn, method, boundMs, run }) => {
    const fetchMock = hangingFetch(
      (url, init) => url.includes(hangOn) && (!method || init?.method === method),
      () => fakeJson({ id: 'cus_new', url: 'https://stripe/x' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const svc = new BillingService({ pool: billingPool(tenant), config: { apiKey: 'sk_test' } });

    const deadline = boundMs ?? STRIPE_TIMEOUT_MS;
    const call = track(run(svc));
    await advance(deadline - 1_000);
    expect(call.state.status).toBe('pending');
    await advance(1_000);

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(hangOn))).toBe(true);
    timedOut(call.state);
  });
});

/** A tenant row whose stripe_customer_id claim behaves like Postgres. */
function customerPool(state: { customerId: string | null }) {
  return fakePool((sql, params) => {
    if (sql.includes('UPDATE tenants') && sql.includes('stripe_customer_id IS NULL')) {
      if (state.customerId) return { rows: [] };
      state.customerId = params[0] as string;
      return { rows: [{ stripe_customer_id: state.customerId }] };
    }
    if (sql.includes('FROM tenants')) return { rows: [{ stripe_customer_id: state.customerId }] };
    return { rows: [] };
  });
}

describe('BillingService — Stripe customer create is idempotent per tenant', () => {
  beforeEach(() => useProviderClock());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const portal = (svc: BillingService, ownerEmail = 'owner@x.com') =>
    svc.getOrCreatePortalUrl({ tenantId: TENANT, ownerEmail, returnUrl: 'https://app/settings' });

  function stripeMintingCustomers(firstCustomer: { status?: number; delayMs?: number } = {}) {
    let n = 0;
    return fakeStripe((call) => {
      if (call.path === '/v1/customers') {
        n += 1;
        if (n === 1 && firstCustomer.status) {
          return { status: firstCustomer.status, body: { error: { message: 'Stripe had a problem' } } };
        }
        return { body: { id: `cus_${n}` }, delayMs: n === 1 ? firstCustomer.delayMs : undefined };
      }
      return { body: { url: 'https://billing.stripe.com/session/x' } };
    });
  }

  it('a create whose answer was lost (timeout) is replayed on the retry: one Stripe customer', async () => {
    const stripe = stripeMintingCustomers({ delayMs: 15_000 });
    vi.stubGlobal('fetch', stripe.fetchFn);
    const state = { customerId: null as string | null };
    const svc = new BillingService({ pool: customerPool(state), config: { apiKey: 'sk_test' } });

    const first = await settleWithin(portal(svc), 15_000); // gave up at 10 s; Stripe finished at 15 s
    const retry = await settleWithin(portal(svc), 0);

    expect(first.status).toBe('rejected');
    expect(retry.status).toBe('fulfilled');
    expect(state.customerId).toBe('cus_1');
    expect(stripe.executedOn('POST', '/v1/customers')).toHaveLength(1);
  });

  it('a lost-response retry that crosses a 10-minute boundary still gets the same customer', async () => {
    // Review round 2 (N1): attempt at 12:09:52 times out after Stripe made
    // cus_1; the retry lands at 12:10:07. A time-windowed key minted cus_2.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-13T12:09:52Z'));
    const stripe = stripeMintingCustomers({ delayMs: 15_000 });
    vi.stubGlobal('fetch', stripe.fetchFn);
    const state = { customerId: null as string | null };
    const svc = new BillingService({ pool: customerPool(state), config: { apiKey: 'sk_test' } });

    const first = await settleWithin(portal(svc), 15_000);
    const retry = await settleWithin(portal(svc), 0);

    expect(first.status).toBe('rejected');
    expect(retry.status).toBe('fulfilled');
    expect(stripe.executedOn('POST', '/v1/customers').map((c) => c.key)).toHaveLength(1);
    expect(state.customerId).toBe('cus_1');
  });

  it('a Stripe error on the customer create does not stick to the next attempt', async () => {
    // Stripe caches the 500 under the key; the retry must not get it back.
    const stripe = stripeMintingCustomers({ status: 500 });
    vi.stubGlobal('fetch', stripe.fetchFn);
    const state = { customerId: null as string | null };
    const svc = new BillingService({ pool: customerPool(state), config: { apiKey: 'sk_test' } });

    const first = await settleWithin(portal(svc), 0);
    const retry = await settleWithin(portal(svc), 0);

    expect(first.status).toBe('rejected');
    expect(retry).toMatchObject({ status: 'fulfilled', value: { url: 'https://billing.stripe.com/session/x' } });
    expect(state.customerId).toBe('cus_2');
  });

  it('a double click (two creates in flight) gets the same customer for both, not an error', async () => {
    const stripe = stripeMintingCustomers({ delayMs: 1_000 });
    vi.stubGlobal('fetch', stripe.fetchFn);
    const state = { customerId: null as string | null };
    const svc = new BillingService({ pool: customerPool(state), config: { apiKey: 'sk_test' } });

    const both = await settleWithin(Promise.all([portal(svc), portal(svc)]), 5_000);

    expect(both.status).toBe('fulfilled');
    expect(state.customerId).toBe('cus_1');
    expect(stripe.executedOn('POST', '/v1/customers')).toHaveLength(1);
  });

  it('another tenant, or a different owner email, gets a different key', async () => {
    const stripe = stripeMintingCustomers();
    const keys: Array<string | undefined> = [];
    for (const [tenantId, email] of [
      [TENANT, 'owner@x.com'],
      ['44444444-4444-4444-8444-444444444444', 'owner@x.com'],
      [TENANT, 'admin@x.com'],
    ]) {
      const svc = new BillingService({
        pool: customerPool({ customerId: null }),
        config: { apiKey: 'sk_test' },
        fetchFn: stripe.fetchFn as unknown as typeof fetch,
      });
      await svc.getOrCreatePortalUrl({ tenantId, ownerEmail: email, returnUrl: 'https://app/settings' });
      keys.push(stripe.executedOn('POST', '/v1/customers').at(-1)?.key);
    }

    const [base, otherTenant, otherEmail] = keys;
    expect(base).toMatch(new RegExp(`^customer:${TENANT}:subscription:`));
    expect(otherTenant).not.toBe(base);
    // Stripe rejects a reused key whose parameters changed, so a different
    // email must not collide with the first attempt's key.
    expect(otherEmail).not.toBe(base);
  });
});

function connectPool(state: { accountId: string | null }) {
  return fakePool((sql, params) => {
    if (sql.includes('SELECT stripe_connect_account_id')) {
      return { rows: [{ stripe_connect_account_id: state.accountId, stripe_connect_status: 'pending' }] };
    }
    if (sql.includes('UPDATE tenants') && sql.includes('stripe_connect_account_id = $1')) {
      // Mirrors Postgres for the guarded claim: only a NULL column is set.
      const guarded = sql.includes('stripe_connect_account_id IS NULL');
      if (guarded && state.accountId) return { rows: [], rowCount: 0 };
      state.accountId = params[0] as string;
      return { rows: [{ stripe_connect_account_id: state.accountId }], rowCount: 1 };
    }
    return { rows: [] };
  });
}

const onboarding = {
  tenantId: TENANT,
  ownerEmail: 'o@x.com',
  returnUrl: 'https://app/settings',
  refreshUrl: 'https://app/settings',
};

describe('StripeConnectService — Stripe calls are bounded when no fetch is injected', () => {
  beforeEach(() => useProviderClock());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    { name: 'Express account create', accountId: null, hangOn: '/v1/accounts' },
    { name: 'onboarding account link', accountId: 'acct_1', hangOn: '/v1/account_links' },
  ])('$name times out at 10 s like a network failure', async ({ accountId, hangOn }) => {
    const fetchMock = hangingFetch((url) => url.endsWith(hangOn), () => fakeJson({ id: 'acct_new', url: 'https://connect/x' }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = new StripeConnectService({ pool: connectPool({ accountId }), config: { apiKey: 'sk_test' } });

    const outcome = await settleWithin(svc.createOnboardingLink(onboarding), STRIPE_TIMEOUT_MS);

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(hangOn))).toBe(true);
    timedOut(outcome);
  });
});

describe('StripeConnectService — Express account create is idempotent per tenant', () => {
  beforeEach(() => useProviderClock());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function stripeMintingAccounts(first: { status?: number; message?: string; delayMs?: number } = {}) {
    let n = 0;
    return fakeStripe((call) => {
      if (call.path === '/v1/accounts') {
        n += 1;
        if (n === 1 && first.status) return { status: first.status, body: { error: { message: first.message } } };
        return { body: { id: `acct_${n}` }, delayMs: n === 1 ? first.delayMs : undefined };
      }
      return { body: { url: `https://connect.stripe.com/setup/${call.params.get('account')}` } };
    });
  }

  it('an account create whose answer was lost (timeout) is replayed on the retry: one Express account', async () => {
    const stripe = stripeMintingAccounts({ delayMs: 15_000 });
    vi.stubGlobal('fetch', stripe.fetchFn);
    const state = { accountId: null as string | null };
    const svc = new StripeConnectService({ pool: connectPool(state), config: { apiKey: 'sk_test' } });

    const first = await settleWithin(svc.createOnboardingLink(onboarding), 15_000);
    const retry = await settleWithin(svc.createOnboardingLink(onboarding), 0);

    expect(first.status).toBe('rejected');
    expect(retry).toMatchObject({ status: 'fulfilled', value: { accountId: 'acct_1' } });
    expect(stripe.executedOn('POST', '/v1/accounts')).toHaveLength(1);
    expect(stripe.executedOn('POST', '/v1/accounts')[0].key).toMatch(new RegExp(`^connect-account:${TENANT}:`));
  });

  it("a cached 'complete your platform profile' rejection does not block onboarding once ops fixed it", async () => {
    const stripe = stripeMintingAccounts({
      status: 400,
      message: 'Please complete your platform profile before creating accounts.',
    });
    vi.stubGlobal('fetch', stripe.fetchFn);
    const state = { accountId: null as string | null };
    const svc = new StripeConnectService({ pool: connectPool(state), config: { apiKey: 'sk_test' } });

    const first = await settleWithin(svc.createOnboardingLink(onboarding), 0);
    const retry = await settleWithin(svc.createOnboardingLink(onboarding), 0);

    expect(first.status).toBe('rejected');
    expect(retry).toMatchObject({ status: 'fulfilled', value: { accountId: 'acct_2' } });
    expect(state.accountId).toBe('acct_2');
  });

  it('a double click on "Connect Stripe" returns the same account to both clicks, not a 502', async () => {
    const stripe = stripeMintingAccounts({ delayMs: 1_000 });
    vi.stubGlobal('fetch', stripe.fetchFn);
    const state = { accountId: null as string | null };
    const svc = new StripeConnectService({ pool: connectPool(state), config: { apiKey: 'sk_test' } });

    const both = await settleWithin(
      Promise.all([svc.createOnboardingLink(onboarding), svc.createOnboardingLink(onboarding)]),
      5_000,
    );

    expect(both.status).toBe('fulfilled');
    const [a, b] = (both as { value: Array<{ accountId: string }> }).value;
    expect([a.accountId, b.accountId]).toEqual(['acct_1', 'acct_1']);
    expect(stripe.executedOn('POST', '/v1/accounts')).toHaveLength(1);
  });
});

describe('StripeConnectService — the first persisted Express account wins', () => {
  it('two racing onboarding requests both continue with the account that was saved first', async () => {
    const state = { accountId: null as string | null };
    // Both requests read "no account" before either persists, and Stripe
    // returns two different accounts (e.g. different owner emails).
    let arrived = 0;
    let releaseCreates: () => void = () => {};
    const bothArrived = new Promise<void>((resolve) => { releaseCreates = resolve; });
    const fetchFn = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/accounts')) {
        const id = arrived === 0 ? 'acct_first' : 'acct_second';
        arrived += 1;
        if (arrived === 2) releaseCreates();
        await bothArrived;
        if (id === 'acct_second') await new Promise((r) => setImmediate(r));
        return fakeJson({ id });
      }
      return fakeJson({ url: 'https://connect.stripe.com/setup/x' });
    });
    const svc = new StripeConnectService({
      pool: connectPool(state),
      config: { apiKey: 'sk_test' },
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const [a, b] = await Promise.all([
      svc.createOnboardingLink(onboarding),
      svc.createOnboardingLink({ ...onboarding, ownerEmail: 'admin@x.com' }),
    ]);

    expect(state.accountId).toBe('acct_first');
    expect(a.accountId).toBe('acct_first');
    expect(b.accountId).toBe('acct_first');
    const linkedAccounts = fetchFn.mock.calls
      .filter(([url]) => String(url).endsWith('/v1/account_links'))
      .map(([, init]) => new URLSearchParams(String((init as RequestInit).body)).get('account'));
    expect(linkedAccounts).toEqual(['acct_first', 'acct_first']);
  });
});
