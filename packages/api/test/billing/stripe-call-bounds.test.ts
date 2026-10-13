/**
 * Reliability #5 / money-data #12 — the subscription and Connect services run
 * their Stripe calls inside the HTTP request transaction. A Stripe call that
 * never answers must not pin the pooled connection until the 60 s idle-tx
 * guard: with no fetch injected (production), every call is bounded at 10 s
 * and fails the same way a network failure does (the raw fetch rejection).
 *
 * Stripe requests whose response can be lost after Stripe acted (customer and
 * Express-account creates) carry a deterministic Idempotency-Key so a retry
 * replays the first object instead of minting a second one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingService } from '../../src/billing/subscription';
import { StripeConnectService } from '../../src/billing/stripe-connect';
import { fakePool } from './fake-pool';
import {
  fakeJson,
  hangingFetch,
  settleWithin,
  useProviderClock,
} from '../helpers/hanging-fetch';

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
      name: 'end trial now',
      tenant: { stripe_subscription_id: 'sub_1' },
      hangOn: '/v1/subscriptions/sub_1',
      run: (svc) => svc.endTrialNow(TENANT),
    },
    {
      name: 'cancel pending checkout: session expire',
      tenant: { pending_checkout_session_id: 'cs_1' },
      hangOn: '/v1/checkout/sessions/cs_1/expire',
      run: (svc) => svc.clearPendingCheckout(TENANT),
    },
  ];

  it.each(cases)('$name times out at 10 s like a network failure', async ({ tenant, hangOn, run }) => {
    const fetchMock = hangingFetch((url) => url.includes(hangOn), () => fakeJson({ id: 'cus_new', url: 'https://stripe/x' }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = new BillingService({ pool: billingPool(tenant), config: { apiKey: 'sk_test' } });

    const outcome = await settleWithin(run(svc), STRIPE_TIMEOUT_MS);

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(hangOn))).toBe(true);
    timedOut(outcome);
  });
});

/** Idempotency-Key sent on each POST to `path`, in call order. */
function keysSentTo(fetchMock: ReturnType<typeof vi.fn>, path: string): Array<string | undefined> {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith(path))
    .map(([, init]) => ((init as RequestInit).headers as Record<string, string>)['Idempotency-Key']);
}

describe('BillingService — Stripe customer create is idempotent per tenant', () => {
  /** The customer-create response is lost (500 after Stripe acted), so the
   *  tenant row never gets the id and the owner retries. */
  function lostCustomerCreate() {
    return vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/v1/customers') ? fakeJson({ error: { message: 'lost' } }, 500) : fakeJson({}),
    );
  }

  async function openPortal(fetchFn: ReturnType<typeof vi.fn>, tenantId: string, ownerEmail: string) {
    const svc = new BillingService({
      pool: billingPool({ stripe_customer_id: null }),
      config: { apiKey: 'sk_test' },
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await svc.getOrCreatePortalUrl({ tenantId, ownerEmail, returnUrl: 'https://app/settings' }).catch(() => undefined);
  }

  it('a retry after a lost response sends the same tenant-scoped Idempotency-Key', async () => {
    const fetchFn = lostCustomerCreate();
    await openPortal(fetchFn, TENANT, 'owner@x.com');
    await openPortal(fetchFn, TENANT, 'owner@x.com');

    const [first, retry] = keysSentTo(fetchFn, '/v1/customers');
    expect(first).toMatch(new RegExp(`^customer:${TENANT}:subscription:`));
    expect(retry).toBe(first);
  });

  it('another tenant, or a different owner email, gets a different key', async () => {
    const fetchFn = lostCustomerCreate();
    await openPortal(fetchFn, TENANT, 'owner@x.com');
    await openPortal(fetchFn, '44444444-4444-4444-8444-444444444444', 'owner@x.com');
    await openPortal(fetchFn, TENANT, 'admin@x.com');

    const [base, otherTenant, otherEmail] = keysSentTo(fetchFn, '/v1/customers');
    expect(base).toBeDefined();
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
  it('a retry after a lost account-create response sends the same tenant-scoped Idempotency-Key', async () => {
    // Stripe created the account but the response never arrived: nothing is
    // persisted, and the owner presses "Connect Stripe" again.
    const fetchFn = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/v1/accounts') ? fakeJson({ error: { message: 'lost' } }, 500) : fakeJson({}),
    );
    const svc = new StripeConnectService({
      pool: connectPool({ accountId: null }),
      config: { apiKey: 'sk_test' },
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await svc.createOnboardingLink(onboarding).catch(() => undefined);
    await svc.createOnboardingLink(onboarding).catch(() => undefined);

    const [first, retry] = keysSentTo(fetchFn, '/v1/accounts');
    expect(first).toMatch(new RegExp(`^connect-account:${TENANT}:`));
    expect(retry).toBe(first);
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
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
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
