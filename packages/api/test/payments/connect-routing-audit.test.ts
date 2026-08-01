/**
 * U9 — Connect-routing audit (cross-surface invariant).
 *
 * THE INVARIANT: a customer charge carries the `Stripe-Account` header (→ a
 * Connect *direct charge* on the tenant's Express account, so funds settle in
 * the tenant's own balance) **iff** that tenant's Connect account is
 * `charges_enabled`. Otherwise the charge falls back to the PLATFORM account
 * (no header) — the money lands with Rivet, not the tenant. The Rivet SaaS
 * subscription is the mirror image: it is billed on the platform and must
 * NEVER carry the header.
 *
 * Why a dedicated audit: the "route to Connect?" decision is duplicated inline
 * across every customer charge surface, and the recurring production bug
 * (prd-stripe-trades-payments: "several customer charge paths still create
 * Stripe objects on the platform account") is a surface that forgot it. This
 * file is the single place that states the invariant and enumerates every
 * surface, so a NEW surface must be added here.
 *
 * SURFACE INVENTORY (charge side) — present-iff-charges_enabled:
 *   1. Public invoice payment link  → test/invoices/public-invoice-connect.test.ts (both sides ✓)
 *   2. Public /pay PaymentIntent     → test/routes/public-payments.route.test.ts (both sides ✓)
 *   3. Operator invoice payment link → test/invoices/invoice-payment-link.test.ts (both sides ✓)
 *   4. Estimate deposit checkout     → test/estimates/*deposit* / public-estimate-service (present ✓)
 *   5. Saved-card off-session dues   → test/payments/stripe-saved-card.test.ts (present ✓)
 *   6. Terminal card-present PI      → ALWAYS Connect (test/payments/stripe-terminal.test.ts) — distinct rule
 *   SaaS subscription (NOT a customer charge) → header must be ABSENT:
 *                                     test/integration/billing-trial.test.ts
 *
 * This file pins the invariant directly at the two general-purpose wrappers
 * every customer surface funnels through (`createPaymentIntent`,
 * `StripePaymentLinkProvider`) — proving present-iff-account uniformly, and
 * that the platform path (= SaaS / not-onboarded) omits the header.
 */
import { describe, it, expect, vi, afterEach, type MockedFunction } from 'vitest';
import { createPaymentIntent, type StripeFetch } from '../../src/payments/stripe-payment-intent';
import { StripePaymentLinkProvider } from '../../src/payments/stripe-payment-link';

describe('U9 Connect-routing audit — Stripe-Account present iff charges_enabled', () => {
  describe('createPaymentIntent (public /pay + saved-card share this wrapper)', () => {
    const input = { amount: 12500, currency: 'usd', invoiceId: 'inv-1', tenantId: 'tenant-1' };

    function okFetch(): MockedFunction<StripeFetch> {
      const spy = vi.fn() as MockedFunction<StripeFetch>;
      spy.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ id: 'pi_1', client_secret: 'pi_1_secret_x' }),
      });
      return spy;
    }

    it('platform charge (no connected account) omits Stripe-Account', async () => {
      const spy = okFetch();
      await createPaymentIntent({ apiKey: 'sk_test' }, input, spy);
      const [, init] = spy.mock.calls[0];
      expect(init.headers['Stripe-Account']).toBeUndefined();
      expect(init.headers['Idempotency-Key']).toBe('pi_inv-1_12500_platform');
    });

    it('Connect direct charge (charges_enabled tenant) sets Stripe-Account + scopes idempotency', async () => {
      const spy = okFetch();
      await createPaymentIntent({ apiKey: 'sk_test' }, { ...input, stripeAccountId: 'acct_tenant_1' }, spy);
      const [, init] = spy.mock.calls[0];
      expect(init.headers['Stripe-Account']).toBe('acct_tenant_1');
      expect(init.headers['Idempotency-Key']).toBe('pi_inv-1_12500_acct_tenant_1');
    });
  });

  describe('StripePaymentLinkProvider (public invoice link + operator link share this wrapper)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function stubFetch() {
      const spy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ id: 'plink_1', url: 'https://checkout.stripe.com/c/plink_1' }),
      }));
      vi.stubGlobal('fetch', spy);
      return spy;
    }

    const req = {
      tenantId: 'tenant-1',
      invoiceId: 'inv-1',
      amountCents: 5000,
      currency: 'usd',
    };

    it('platform charge (no connected account) omits Stripe-Account', async () => {
      const spy = stubFetch();
      await new StripePaymentLinkProvider({ apiKey: 'sk_test', webhookSecret: 'whsec' }).generateLink(req);
      const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers['Stripe-Account']).toBeUndefined();
    });

    it('Connect direct charge (charges_enabled tenant) sets Stripe-Account', async () => {
      const spy = stubFetch();
      await new StripePaymentLinkProvider({ apiKey: 'sk_test', webhookSecret: 'whsec' }).generateLink({
        ...req,
        stripeAccountId: 'acct_tenant_1',
      });
      const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers['Stripe-Account']).toBe('acct_tenant_1');
    });

    it('a blank/whitespace account id is treated as platform (never a header with an empty value)', async () => {
      const spy = stubFetch();
      await new StripePaymentLinkProvider({ apiKey: 'sk_test', webhookSecret: 'whsec' }).generateLink({
        ...req,
        stripeAccountId: '   ',
      });
      const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers['Stripe-Account']).toBeUndefined();
    });
  });
});
