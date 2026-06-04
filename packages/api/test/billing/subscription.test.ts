import { describe, it, expect, vi, beforeEach } from 'vitest';
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
});
