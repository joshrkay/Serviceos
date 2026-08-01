import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { BillingService } from '../../src/billing/subscription';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';

describe('BillingService — trial flows', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('createTrialCheckoutSession', () => {
    it('calls Stripe Checkout API with trial_period_days=14 and returns url', async () => {
      // Two-step Stripe interaction: first POST /v1/customers to mint
      // (or reuse) the tenant's canonical customer, then POST
      // /v1/checkout/sessions binding that customer. Mock returns the
      // right shape per call so getOrCreateStripeCustomer and
      // createTrialCheckoutSession each see what they expect.
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'cus_test_abc' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ url: 'https://checkout.stripe.com/test_sess_abc' }),
        } as Response);
      const svc = new BillingService({ pool, config: { apiKey: 'sk_test_x' }, fetchFn: fetchMock as unknown as typeof fetch });
      process.env.STRIPE_PRICE_ID = 'price_test_1';

      const tenant = await createTestTenant(pool);
      const { url } = await svc.createTrialCheckoutSession({
        tenantId: tenant.tenantId,
        ownerEmail: 'owner@example.com',
        successUrl: 'https://app.test/onboarding?billing=ok',
        cancelUrl: 'https://app.test/onboarding?billing=cancel',
      });
      expect(url).toBe('https://checkout.stripe.com/test_sess_abc');
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'https://api.stripe.com/v1/customers',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        'https://api.stripe.com/v1/checkout/sessions',
        expect.objectContaining({ method: 'POST' }),
      );
      const checkoutCallArgs = fetchMock.mock.calls[1][1] as RequestInit;
      const body = (checkoutCallArgs.body as URLSearchParams).toString();
      expect(body).toContain('mode=subscription');
      expect(body).toContain('subscription_data%5Btrial_period_days%5D=14');
      expect(body).toContain('payment_method_collection=always');
      // Trial checkout now binds to the persisted customer id rather than
      // letting Stripe mint a new customer per session.
      expect(body).toContain('customer=cus_test_abc');
      expect(body).not.toContain('customer_email=');

      // U9 invariant (SaaS side): the Rivet SaaS subscription is billed on the
      // PLATFORM account and must NEVER carry a Stripe-Account header — that
      // header would route the platform's own subscription revenue onto a
      // tenant's connected account. Neither the customer-create nor the
      // checkout-session call may set it. (Connect direct charges — the
      // customer-facing invoice/deposit surfaces — are the ONLY paths that do;
      // see connect-routing-audit.test.ts.)
      for (const call of fetchMock.mock.calls) {
        const headers = ((call[1] as RequestInit).headers ?? {}) as Record<string, string>;
        expect(headers['Stripe-Account']).toBeUndefined();
      }
      delete process.env.STRIPE_PRICE_ID;
    });

    it('throws when STRIPE_PRICE_ID is unset', async () => {
      const svc = new BillingService({ pool, config: { apiKey: 'sk_test_x' } });
      delete process.env.STRIPE_PRICE_ID;
      const tenant = await createTestTenant(pool);
      await expect(
        svc.createTrialCheckoutSession({
          tenantId: tenant.tenantId,
          ownerEmail: 'a@b.c',
          successUrl: 'https://x',
          cancelUrl: 'https://x',
        }),
      ).rejects.toThrow();
    });

    it('throws when billingService has no api key', async () => {
      process.env.STRIPE_PRICE_ID = 'price_test_1';
      const svc = new BillingService({ pool, config: null });
      const tenant = await createTestTenant(pool);
      await expect(
        svc.createTrialCheckoutSession({
          tenantId: tenant.tenantId,
          ownerEmail: 'a@b.c',
          successUrl: 'https://x',
          cancelUrl: 'https://x',
        }),
      ).rejects.toThrow('Subscription billing is not configured');
      delete process.env.STRIPE_PRICE_ID;
    });
  });

  describe('endTrialNow', () => {
    it('calls Stripe Update Subscription with trial_end=now', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'sub_1', status: 'active' }),
      } as Response);
      const svc = new BillingService({ pool, config: { apiKey: 'sk_test_x' }, fetchFn: fetchMock as unknown as typeof fetch });
      const tenant = await createTestTenant(pool);
      await pool.query(
        `UPDATE tenants SET stripe_subscription_id='sub_1' WHERE id=$1`,
        [tenant.tenantId],
      );

      await svc.endTrialNow(tenant.tenantId);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.stripe.com/v1/subscriptions/sub_1',
        expect.objectContaining({ method: 'POST' }),
      );
      const body = (
        (fetchMock.mock.calls[0][1] as RequestInit).body as URLSearchParams
      ).toString();
      expect(body).toContain('trial_end=now');
      expect(body).toContain('proration_behavior=create_prorations');
    });

    it('throws NotFoundError when no subscription is on file', async () => {
      const svc = new BillingService({ pool, config: { apiKey: 'sk_test_x' } });
      const tenant = await createTestTenant(pool);
      await expect(svc.endTrialNow(tenant.tenantId)).rejects.toThrow();
    });

    it('throws NotFoundError when tenant does not exist', async () => {
      const svc = new BillingService({ pool, config: { apiKey: 'sk_test_x' } });
      await expect(svc.endTrialNow('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
    });
  });
});
