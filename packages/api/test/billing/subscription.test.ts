import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BillingService } from '../../src/billing/subscription';

const TENANT = '11111111-1111-4111-8111-111111111111';

/**
 * Tier 4 (Subscription — Rivet billing) — BillingService unit tests.
 * The service queries Pg directly via `pool.query`; we stub the pool
 * with a vi.fn() that pattern-matches SQL strings. The Stripe API is
 * stubbed via the injectable fetchFn dependency.
 */
function makePool(rows: Record<string, unknown> = {}) {
  // Map of (sql substring → response). Some responses are dynamic
  // (function form) so the mock can mirror RETURNING semantics — the
  // UPDATE that claims stripe_customer_id RETURNs the value being set,
  // so getOrCreateStripeCustomer can distinguish a winning claim from
  // a concurrent-race no-op.
  type StaticResponse = { rows: Record<string, unknown>[] };
  type DynamicResponse = (sql: string, params?: unknown[]) => StaticResponse;
  const responses = new Map<string, StaticResponse | DynamicResponse>([
    [
      'SELECT stripe_customer_id, stripe_subscription_id, subscription_status',
      { rows: [rows] },
    ],
    ['SELECT stripe_customer_id FROM tenants', { rows: [rows] }],
    // createTrialCheckoutSession serializes per tenant via a Postgres
    // advisory transaction lock. Default mock: the lock is always
    // available (we're a single test). Tests that exercise the
    // "concurrent checkout" path can override this entry to return
    // `{ locked: false }`.
    ['pg_try_advisory_xact_lock', { rows: [{ locked: true }] }],
    ['SELECT subscription_status FROM tenants', { rows: [rows] }],
    [
      'SELECT subscription_status, pending_checkout_at',
      { rows: [{ ...rows, pending_checkout_at: null }] },
    ],
    [
      'SELECT pending_checkout_session_id',
      { rows: [{ pending_checkout_session_id: null }] },
    ],
    [
      'UPDATE tenants\n          SET stripe_customer_id',
      (_sql, params) => ({ rows: [{ stripe_customer_id: params?.[0] }] }),
    ],
    ['UPDATE tenants SET stripe_customer_id', { rows: [] }],
    ['UPDATE tenants', { rows: [] }],
  ]);

  const queryMock = vi.fn(async (sql: string, params?: unknown[]) => {
    for (const [needle, response] of responses) {
      if (sql.includes(needle)) {
        return typeof response === 'function' ? response(sql, params) : response;
      }
    }
    return { rows: [] };
  });

  // pool.connect() returns a checked-out Client. We hand back an
  // object that shares the same query mock so all the matching logic
  // above applies, plus a no-op release().
  const connectMock = vi.fn(async () => ({
    query: queryMock,
    release: vi.fn(),
  }));

  return { query: queryMock, connect: connectMock, responses };
}

function jsonOk(body: unknown): Response {
  return {
    ok: true, status: 200, statusText: 'OK',
    json: async () => body, text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function jsonErr(status: number, body: unknown): Response {
  return {
    ok: false, status, statusText: 'Error',
    json: async () => body, text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('BillingService', () => {
  let pool: ReturnType<typeof makePool>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchFn: any;

  beforeEach(() => {
    pool = makePool({});
    fetchFn = vi.fn();
  });

  it('getSubscription returns null fields for a fresh tenant', async () => {
    pool = makePool({
      stripe_customer_id: null,
      stripe_subscription_id: null,
      subscription_status: null,
    });
    const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
    const view = await svc.getSubscription(TENANT);
    expect(view).toEqual({ customerId: null, subscriptionId: null, status: null });
  });

  it('getSubscription throws NotFoundError when tenant row missing', async () => {
    pool.query = vi.fn(async (sql: string, _params?: unknown[]) => ({ rows: [] as Record<string, unknown>[] }));
    const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
    await expect(svc.getSubscription(TENANT)).rejects.toThrow(/Tenant/);
  });

  it('getOrCreatePortalUrl creates a Stripe customer + persists the id on first open', async () => {
    pool = makePool({ stripe_customer_id: null });
    fetchFn
      .mockResolvedValueOnce(jsonOk({ id: 'cus_xyz' }))
      .mockResolvedValueOnce(jsonOk({ url: 'https://billing.stripe.com/p/test_session' }));

    const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
    const result = await svc.getOrCreatePortalUrl({
      tenantId: TENANT,
      ownerEmail: 'owner@example.com',
      returnUrl: 'https://app.example.com/settings',
    });

    expect(result.url).toBe('https://billing.stripe.com/p/test_session');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // First call: customers create.
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.stripe.com/v1/customers');
    // Second call: portal session.
    expect(fetchFn.mock.calls[1][0]).toBe('https://api.stripe.com/v1/billing_portal/sessions');
    // Customer id was persisted.
    const persistCall = pool.query.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('SET stripe_customer_id'),
    );
    expect(persistCall).toBeDefined();
  });

  it('getOrCreatePortalUrl reuses existing customer id (idempotent)', async () => {
    pool = makePool({ stripe_customer_id: 'cus_existing' });
    fetchFn.mockResolvedValueOnce(
      jsonOk({ url: 'https://billing.stripe.com/p/reused' }),
    );
    const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
    const result = await svc.getOrCreatePortalUrl({
      tenantId: TENANT,
      ownerEmail: 'owner@example.com',
      returnUrl: 'https://app.example.com/settings',
    });
    expect(result.url).toBe('https://billing.stripe.com/p/reused');
    // Only ONE fetch — no customer create.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.stripe.com/v1/billing_portal/sessions');
  });

  it('rejects when no Stripe key is configured', async () => {
    pool = makePool({ stripe_customer_id: null });
    const svc = new BillingService({ pool: pool as never, config: null, fetchFn });
    await expect(
      svc.getOrCreatePortalUrl({
        tenantId: TENANT,
        ownerEmail: 'owner@example.com',
        returnUrl: 'https://app.example.com/settings',
      }),
    ).rejects.toThrow(/not configured/i);
  });

  it('surfaces Stripe customer-create errors', async () => {
    pool = makePool({ stripe_customer_id: null });
    fetchFn.mockResolvedValueOnce(jsonErr(400, { error: { message: 'invalid email' } }));
    const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
    await expect(
      svc.getOrCreatePortalUrl({
        tenantId: TENANT,
        ownerEmail: 'bad@example.com',
        returnUrl: 'https://app.example.com/settings',
      }),
    ).rejects.toThrow(/Stripe customer creation failed/i);
  });

  it('getOrCreatePortalUrl rejects a missing returnUrl', async () => {
    pool = makePool({ stripe_customer_id: 'cus_existing' });
    const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
    await expect(
      svc.getOrCreatePortalUrl({ tenantId: TENANT, ownerEmail: 'o@example.com', returnUrl: '' }),
    ).rejects.toThrow(/returnUrl is required/);
  });

  it('getOrCreatePortalUrl passes the portal configuration id when configured', async () => {
    pool = makePool({ stripe_customer_id: 'cus_existing' });
    fetchFn.mockResolvedValueOnce(jsonOk({ url: 'https://billing.stripe.com/p/cfg' }));
    const svc = new BillingService({
      pool: pool as never,
      config: { apiKey: 'sk_test', portalConfigurationId: 'bpc_123' },
      fetchFn,
    });
    await svc.getOrCreatePortalUrl({
      tenantId: TENANT,
      ownerEmail: 'o@example.com',
      returnUrl: 'https://app.example.com/settings',
    });
    const body = fetchFn.mock.calls[0][1].body as URLSearchParams;
    expect(body.get('configuration')).toBe('bpc_123');
  });

  it('getOrCreatePortalUrl surfaces portal-session failures and missing urls', async () => {
    pool = makePool({ stripe_customer_id: 'cus_existing' });
    fetchFn.mockResolvedValueOnce(jsonErr(500, { error: { message: 'boom' } }));
    const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
    const input = {
      tenantId: TENANT,
      ownerEmail: 'o@example.com',
      returnUrl: 'https://app.example.com/settings',
    };
    await expect(svc.getOrCreatePortalUrl(input)).rejects.toThrow(
      /Stripe portal session failed \(500\)/,
    );

    fetchFn.mockResolvedValueOnce(jsonOk({}));
    await expect(svc.getOrCreatePortalUrl(input)).rejects.toThrow(/returned no url/);
  });

  it('surfaces a Stripe customer create that returns no id', async () => {
    pool = makePool({ stripe_customer_id: null });
    fetchFn.mockResolvedValueOnce(jsonOk({}));
    const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
    await expect(
      svc.getOrCreatePortalUrl({
        tenantId: TENANT,
        ownerEmail: 'o@example.com',
        returnUrl: 'https://app.example.com/settings',
      }),
    ).rejects.toThrow(/returned no id/);
  });

  it('re-reads the winning customer id after losing the claim race', async () => {
    pool = makePool({ stripe_customer_id: null });
    // The conditional UPDATE claims nothing (another caller won) …
    pool.responses.set('UPDATE tenants\n          SET stripe_customer_id', { rows: [] });
    // … and the re-read sees the winner's id. First SELECT (pre-create)
    // still returns null so the create path is entered.
    let selects = 0;
    pool.responses.set('SELECT stripe_customer_id FROM tenants', () => ({
      rows: [{ stripe_customer_id: selects++ === 0 ? null : 'cus_winner' }],
    }));
    fetchFn
      .mockResolvedValueOnce(jsonOk({ id: 'cus_loser' }))
      .mockResolvedValueOnce(jsonOk({ url: 'https://billing.stripe.com/p/won' }));

    const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
    await svc.getOrCreatePortalUrl({
      tenantId: TENANT,
      ownerEmail: 'o@example.com',
      returnUrl: 'https://app.example.com/settings',
    });
    // The portal session must be minted for the WINNER's customer.
    const body = fetchFn.mock.calls[1][1].body as URLSearchParams;
    expect(body.get('customer')).toBe('cus_winner');
  });

  it('applySubscriptionEvent writes the latest snapshot keyed by customer id', async () => {
    const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
    await svc.applySubscriptionEvent({
      customerId: 'cus_xyz',
      subscriptionId: 'sub_abc',
      status: 'active',
    });
    const call = pool.query.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('SET stripe_subscription_id'),
    );
    expect(call).toBeDefined();
    expect(call![1]).toEqual(['sub_abc', 'active', 'cus_xyz']);
  });

  describe('applySubscriptionEvent — Stripe webhook transition table', () => {
    // Every customer.subscription.* status Stripe can send must land
    // verbatim in subscription_status: the trial gate in
    // createTrialCheckoutSession and the app's paywall both key off
    // this cached column.
    const STRIPE_STATUSES = [
      'trialing',
      'active',
      'past_due',
      'canceled',
      'unpaid',
      'incomplete',
      'incomplete_expired',
      'paused',
    ] as const;

    it.each(STRIPE_STATUSES)('mirrors status %s onto the tenant row', async (status) => {
      const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
      await svc.applySubscriptionEvent({
        customerId: 'cus_xyz',
        subscriptionId: 'sub_abc',
        status,
      });
      const call = pool.query.mock.calls.find((c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).includes('SET stripe_subscription_id'),
      );
      expect(call![1]).toEqual(['sub_abc', status, 'cus_xyz']);
      // Without trialEndsAt the cached trial_ends_at must be left untouched.
      expect(call![0]).not.toContain('trial_ends_at');
    });

    it('writes trial_ends_at when a trial end date is supplied', async () => {
      const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
      const trialEnd = new Date('2026-07-24T00:00:00Z');
      await svc.applySubscriptionEvent({
        customerId: 'cus_xyz',
        subscriptionId: 'sub_abc',
        status: 'trialing',
        trialEndsAt: trialEnd,
      });
      const call = pool.query.mock.calls.find((c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).includes('trial_ends_at'),
      );
      expect(call).toBeDefined();
      expect(call![1]).toEqual(['sub_abc', 'trialing', trialEnd, 'cus_xyz']);
    });

    it('clears trial_ends_at when the event carries an explicit null (trial over)', async () => {
      const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
      await svc.applySubscriptionEvent({
        customerId: 'cus_xyz',
        subscriptionId: 'sub_abc',
        status: 'active',
        trialEndsAt: null,
      });
      const call = pool.query.mock.calls.find((c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).includes('trial_ends_at'),
      );
      expect(call).toBeDefined();
      expect(call![1]).toEqual(['sub_abc', 'active', null, 'cus_xyz']);
    });
  });

  describe('createTrialCheckoutSession', () => {
    const INPUT = {
      tenantId: TENANT,
      ownerEmail: 'owner@example.com',
      successUrl: 'https://app.example.com/settings?checkout=success',
      cancelUrl: 'https://app.example.com/settings?checkout=cancel',
    };

    beforeEach(() => {
      vi.stubEnv('STRIPE_PRICE_ID', 'price_test_123');
      pool = makePool({ stripe_customer_id: 'cus_existing', subscription_status: null });
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    function makeSvc() {
      return new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
    }

    it('mints a 14-day trial checkout session and stamps the pending markers', async () => {
      fetchFn.mockResolvedValueOnce(
        jsonOk({ id: 'cs_new', url: 'https://checkout.stripe.com/c/pay/cs_new' }),
      );
      const result = await makeSvc().createTrialCheckoutSession(INPUT);
      expect(result.url).toBe('https://checkout.stripe.com/c/pay/cs_new');

      expect(fetchFn.mock.calls[0][0]).toBe('https://api.stripe.com/v1/checkout/sessions');
      const body = fetchFn.mock.calls[0][1].body as URLSearchParams;
      expect(body.get('mode')).toBe('subscription');
      expect(body.get('line_items[0][price]')).toBe('price_test_123');
      expect(body.get('subscription_data[trial_period_days]')).toBe('14');
      expect(body.get('subscription_data[metadata][tenant_id]')).toBe(TENANT);
      expect(body.get('customer')).toBe('cus_existing');

      const stamp = pool.query.mock.calls.find((c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).includes('SET pending_checkout_at = NOW()'),
      );
      expect(stamp).toBeDefined();
      expect(stamp![1]).toEqual([TENANT, 'cs_new']);
      const sqlCalls = pool.query.mock.calls.map((c: unknown[]) => c[0]);
      expect(sqlCalls).toContain('COMMIT');
    });

    it('refuses when the per-tenant advisory lock is already held', async () => {
      pool.responses.set('pg_try_advisory_xact_lock', { rows: [{ locked: false }] });
      await expect(makeSvc().createTrialCheckoutSession(INPUT)).rejects.toThrow(
        /already in progress/,
      );
      expect(fetchFn).not.toHaveBeenCalled();
      expect(pool.query.mock.calls.map((c: unknown[]) => c[0])).toContain('ROLLBACK');
    });

    it.each(['trialing', 'active', 'past_due'])(
      'refuses when subscription_status is already %s',
      async (status) => {
        pool.responses.set('SELECT subscription_status, pending_checkout_at', {
          rows: [{ subscription_status: status, pending_checkout_at: null }],
        });
        await expect(makeSvc().createTrialCheckoutSession(INPUT)).rejects.toThrow(
          /already active/,
        );
        expect(fetchFn).not.toHaveBeenCalled();
      },
    );

    it('refuses while a recent checkout is still pending (<32 min)', async () => {
      pool.responses.set('SELECT subscription_status, pending_checkout_at', {
        rows: [
          {
            subscription_status: null,
            pending_checkout_at: new Date(Date.now() - 5 * 60 * 1000),
          },
        ],
      });
      await expect(makeSvc().createTrialCheckoutSession(INPUT)).rejects.toThrow(
        /just started/,
      );
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('proceeds when the pending marker is stale (>32 min)', async () => {
      pool.responses.set('SELECT subscription_status, pending_checkout_at', {
        rows: [
          {
            subscription_status: null,
            pending_checkout_at: new Date(Date.now() - 45 * 60 * 1000),
          },
        ],
      });
      fetchFn.mockResolvedValueOnce(
        jsonOk({ id: 'cs_retry', url: 'https://checkout.stripe.com/c/pay/cs_retry' }),
      );
      const result = await makeSvc().createTrialCheckoutSession(INPUT);
      expect(result.url).toBe('https://checkout.stripe.com/c/pay/cs_retry');
    });

    it('rolls back and surfaces a Stripe checkout failure', async () => {
      fetchFn.mockResolvedValueOnce(jsonErr(402, { error: { message: 'card required' } }));
      await expect(makeSvc().createTrialCheckoutSession(INPUT)).rejects.toThrow(
        /Stripe checkout session failed \(402\)/,
      );
      const sqlCalls = pool.query.mock.calls.map((c: unknown[]) => c[0]);
      expect(sqlCalls).toContain('ROLLBACK');
      expect(sqlCalls).not.toContain('COMMIT');
    });

    it('throws when the checkout session comes back without a url', async () => {
      fetchFn.mockResolvedValueOnce(jsonOk({ id: 'cs_broken' }));
      await expect(makeSvc().createTrialCheckoutSession(INPUT)).rejects.toThrow(
        /returned no url/,
      );
    });

    it('rejects when STRIPE_PRICE_ID is not set', async () => {
      vi.stubEnv('STRIPE_PRICE_ID', '');
      await expect(makeSvc().createTrialCheckoutSession(INPUT)).rejects.toThrow(
        /STRIPE_PRICE_ID/,
      );
    });

    it('rejects when billing is not configured', async () => {
      const svc = new BillingService({ pool: pool as never, config: null, fetchFn });
      await expect(svc.createTrialCheckoutSession(INPUT)).rejects.toThrow(/not configured/i);
    });
  });

  describe('endTrialNow', () => {
    it('ends the trial immediately with prorations', async () => {
      pool.responses.set('SELECT stripe_subscription_id FROM tenants', {
        rows: [{ stripe_subscription_id: 'sub_live' }],
      });
      fetchFn.mockResolvedValueOnce(jsonOk({ id: 'sub_live', status: 'active' }));
      const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
      await svc.endTrialNow(TENANT);

      expect(fetchFn.mock.calls[0][0]).toBe('https://api.stripe.com/v1/subscriptions/sub_live');
      const body = fetchFn.mock.calls[0][1].body as URLSearchParams;
      expect(body.get('trial_end')).toBe('now');
      expect(body.get('proration_behavior')).toBe('create_prorations');
    });

    it('throws NotFoundError when the tenant has no subscription on file', async () => {
      pool.responses.set('SELECT stripe_subscription_id FROM tenants', {
        rows: [{ stripe_subscription_id: null }],
      });
      const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
      await expect(svc.endTrialNow(TENANT)).rejects.toThrow(/Subscription/);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the tenant row is missing', async () => {
      pool.responses.set('SELECT stripe_subscription_id FROM tenants', { rows: [] });
      const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
      await expect(svc.endTrialNow(TENANT)).rejects.toThrow(/Tenant/);
    });

    it('surfaces a Stripe subscription-update failure', async () => {
      pool.responses.set('SELECT stripe_subscription_id FROM tenants', {
        rows: [{ stripe_subscription_id: 'sub_live' }],
      });
      fetchFn.mockResolvedValueOnce(jsonErr(500, { error: { message: 'stripe down' } }));
      const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
      await expect(svc.endTrialNow(TENANT)).rejects.toThrow(
        /Stripe subscription update failed \(500\)/,
      );
    });

    it('rejects when billing is not configured', async () => {
      const svc = new BillingService({ pool: pool as never, config: null, fetchFn });
      await expect(svc.endTrialNow(TENANT)).rejects.toThrow(/not configured/i);
    });
  });

  describe('clearPendingCheckout', () => {
    function clearCall() {
      return pool.query.mock.calls.find((c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).includes('SET pending_checkout_at = NULL'),
      );
    }

    it('clears the pending markers without calling Stripe when no session id is stamped', async () => {
      const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
      await svc.clearPendingCheckout(TENANT);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(clearCall()).toBeDefined();
      expect(clearCall()![1]).toEqual([TENANT]);
    });

    it('expires the stamped Stripe session before clearing the markers', async () => {
      pool.responses.set('SELECT pending_checkout_session_id', {
        rows: [{ pending_checkout_session_id: 'cs_stale' }],
      });
      fetchFn.mockResolvedValueOnce(jsonOk({ id: 'cs_stale', status: 'expired' }));
      const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
      await svc.clearPendingCheckout(TENANT);

      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn.mock.calls[0][0]).toBe(
        'https://api.stripe.com/v1/checkout/sessions/cs_stale/expire',
      );
      expect(clearCall()).toBeDefined();
    });

    it('treats a 404 from the expire endpoint as success (goal state reached)', async () => {
      pool.responses.set('SELECT pending_checkout_session_id', {
        rows: [{ pending_checkout_session_id: 'cs_gone' }],
      });
      fetchFn.mockResolvedValueOnce(jsonErr(404, { error: { message: 'no such session' } }));
      const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
      await svc.clearPendingCheckout(TENANT);
      expect(clearCall()).toBeDefined();
    });

    it('leaves the markers stamped when Stripe fails, so the gate keeps refusing checkouts', async () => {
      pool.responses.set('SELECT pending_checkout_session_id', {
        rows: [{ pending_checkout_session_id: 'cs_live' }],
      });
      fetchFn.mockResolvedValueOnce(jsonErr(500, { error: { message: 'stripe down' } }));
      const svc = new BillingService({ pool: pool as never, config: { apiKey: 'sk_test' }, fetchFn });
      await expect(svc.clearPendingCheckout(TENANT)).rejects.toThrow(
        /Stripe session expire failed \(500\)/,
      );
      expect(clearCall()).toBeUndefined();
    });

    it('skips the expire call but still clears markers when billing is not configured', async () => {
      pool.responses.set('SELECT pending_checkout_session_id', {
        rows: [{ pending_checkout_session_id: 'cs_orphan' }],
      });
      const svc = new BillingService({ pool: pool as never, config: null, fetchFn });
      await svc.clearPendingCheckout(TENANT);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(clearCall()).toBeDefined();
    });
  });
});
