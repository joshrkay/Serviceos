import type { Pool } from 'pg';
import { ValidationError, NotFoundError } from '../shared/errors';

/**
 * Tier 4 (Subscription — Fieldly billing). Service that mints Stripe
 * Customer Portal sessions for the tenant's SaaS subscription. Distinct
 * from `public-invoice-service.getOrCreateCheckoutUrl` (which is
 * billing the TENANT's customers via Stripe Connect — different
 * Stripe account/concept entirely).
 *
 * Flow on first portal-open:
 *   1. Look up tenants.stripe_customer_id. If missing, create a
 *      Stripe Customer with the owner's email and persist the id.
 *   2. Call POST /v1/billing_portal/sessions with the customer id +
 *      a return_url back to /settings.
 *   3. Return the session URL.
 *
 * Idempotent on stripe_customer_id: a returning operator skips the
 * Customer creation step. Subscription status is read from the cached
 * `subscription_status` column, refreshed by the Stripe webhook.
 */

export interface BillingConfig {
  apiKey: string;
  /** Stripe Pricing Table / portal config id (optional, Stripe defaults). */
  portalConfigurationId?: string;
}

export type BillingFetch = typeof fetch;

export interface BillingSubscriptionView {
  /** Stripe customer.id when one exists, else null. */
  customerId: string | null;
  /** Stripe subscription.id when subscribed, else null. */
  subscriptionId: string | null;
  /** Mirror of Stripe subscription.status. Null until first sub. */
  status: string | null;
}

export interface BillingServiceDeps {
  pool: Pool;
  config?: BillingConfig | null;
  /** Stub-able for tests. Defaults to global fetch. */
  fetchFn?: BillingFetch;
}

export class BillingService {
  constructor(private deps: BillingServiceDeps) {}

  /**
   * Fetches the tenant's subscription view from the cached columns
   * on `tenants`. Returns null fields when nothing has been minted
   * yet (tenant predates migration 083, or the operator hasn't
   * opened the portal yet).
   */
  async getSubscription(tenantId: string): Promise<BillingSubscriptionView> {
    const { rows } = await this.deps.pool.query(
      `SELECT stripe_customer_id, stripe_subscription_id, subscription_status
       FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (rows.length === 0) {
      throw new NotFoundError('Tenant', tenantId);
    }
    const row = rows[0] as Record<string, unknown>;
    return {
      customerId: (row.stripe_customer_id as string | null) ?? null,
      subscriptionId: (row.stripe_subscription_id as string | null) ?? null,
      status: (row.subscription_status as string | null) ?? null,
    };
  }

  /**
   * Mints a Stripe Customer Portal session and returns its URL.
   * Lazily creates the Stripe Customer the first time, persisting
   * the id on the tenant row so subsequent calls reuse it.
   *
   *   returnUrl : where Stripe sends the operator after they close
   *               the portal (typically /settings).
   *   ownerEmail: used to populate Stripe Customer.email when we
   *               first create it. Read from req.auth or the tenant
   *               row by the route layer.
   */
  async getOrCreatePortalUrl(input: {
    tenantId: string;
    ownerEmail: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    if (!this.deps.config?.apiKey) {
      throw new ValidationError('Subscription billing is not configured');
    }
    const { tenantId, ownerEmail, returnUrl } = input;
    if (!returnUrl) {
      throw new ValidationError('returnUrl is required');
    }

    const fetchFn = this.deps.fetchFn ?? fetch;
    const apiKey = this.deps.config.apiKey;

    // Step 1 — look up or create the Stripe customer.
    const { rows } = await this.deps.pool.query(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (rows.length === 0) throw new NotFoundError('Tenant', tenantId);
    let customerId = (rows[0] as Record<string, unknown>).stripe_customer_id as
      | string
      | null;

    if (!customerId) {
      const customerRes = await fetchFn('https://api.stripe.com/v1/customers', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          email: ownerEmail,
          'metadata[tenant_id]': tenantId,
        }),
      });
      if (!customerRes.ok) {
        const body = await customerRes.text();
        throw new Error(`Stripe customer creation failed (${customerRes.status}): ${body}`);
      }
      const customer = (await customerRes.json()) as { id?: string };
      if (!customer.id) {
        throw new Error('Stripe customer creation returned no id');
      }
      customerId = customer.id;

      await this.deps.pool.query(
        `UPDATE tenants SET stripe_customer_id = $1, updated_at = NOW() WHERE id = $2`,
        [customerId, tenantId],
      );
    }

    // Step 2 — mint the portal session.
    const params = new URLSearchParams({
      customer: customerId,
      return_url: returnUrl,
    });
    if (this.deps.config.portalConfigurationId) {
      params.set('configuration', this.deps.config.portalConfigurationId);
    }

    const sessionRes = await fetchFn('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    if (!sessionRes.ok) {
      const body = await sessionRes.text();
      throw new Error(`Stripe portal session failed (${sessionRes.status}): ${body}`);
    }
    const session = (await sessionRes.json()) as { url?: string };
    if (!session.url) {
      throw new Error('Stripe portal session returned no url');
    }
    return { url: session.url };
  }

  /**
   * Creates a Stripe Checkout Session for a 14-day trial subscription.
   * The operator is redirected to Stripe-hosted checkout where they
   * enter card details. Trial starts immediately; billing begins after
   * 14 days. Requires STRIPE_PRICE_ID to be set in the environment.
   */
  async createTrialCheckoutSession(input: {
    tenantId: string;
    ownerEmail: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string }> {
    if (!this.deps.config?.apiKey) {
      throw new ValidationError('Subscription billing is not configured');
    }
    const priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId) {
      throw new ValidationError('STRIPE_PRICE_ID is not set');
    }
    const fetchFn = this.deps.fetchFn ?? fetch;
    const body = new URLSearchParams();
    body.set('mode', 'subscription');
    body.set('line_items[0][price]', priceId);
    body.set('line_items[0][quantity]', '1');
    body.set('subscription_data[trial_period_days]', '14');
    body.set('subscription_data[metadata][tenant_id]', input.tenantId);
    body.set('payment_method_collection', 'always');
    body.set('customer_email', input.ownerEmail);
    body.set('success_url', input.successUrl);
    body.set('cancel_url', input.cancelUrl);
    body.set('client_reference_id', input.tenantId);
    const res = await fetchFn('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.deps.config.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Stripe checkout session failed (${res.status}): ${text}`);
    }
    const session = (await res.json()) as { url?: string };
    if (!session.url) {
      throw new Error('Stripe checkout session returned no url');
    }
    return { url: session.url };
  }

  /**
   * Ends the tenant's trial immediately by updating the Stripe
   * subscription with `trial_end=now`. Prorations are created so the
   * operator is billed for any time already used in the billing cycle.
   * Throws NotFoundError when the tenant has no subscription on file.
   */
  async endTrialNow(tenantId: string): Promise<void> {
    if (!this.deps.config?.apiKey) {
      throw new ValidationError('Subscription billing is not configured');
    }
    const { rows } = await this.deps.pool.query(
      `SELECT stripe_subscription_id FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (rows.length === 0) {
      throw new NotFoundError('Tenant', tenantId);
    }
    const subId = (rows[0] as Record<string, unknown>).stripe_subscription_id as string | null;
    if (!subId) {
      throw new NotFoundError('Subscription', tenantId);
    }
    const fetchFn = this.deps.fetchFn ?? fetch;
    const body = new URLSearchParams();
    body.set('trial_end', 'now');
    body.set('proration_behavior', 'create_prorations');
    const res = await fetchFn(`https://api.stripe.com/v1/subscriptions/${subId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.deps.config.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Stripe subscription update failed (${res.status}): ${text}`);
    }
  }

  /**
   * Webhook handler — applies a customer.subscription.* event onto
   * the cached columns. Called by the Stripe webhook route when
   * deps.billingService is wired.
   *
   * Idempotent: writes the latest snapshot and returns. Stripe sends
   * deltas, but we only care about the current state so no merge
   * logic is needed.
   */
  async applySubscriptionEvent(input: {
    customerId: string;
    subscriptionId: string;
    status: string;
  }): Promise<void> {
    await this.deps.pool.query(
      `UPDATE tenants
       SET stripe_subscription_id = $1, subscription_status = $2, updated_at = NOW()
       WHERE stripe_customer_id = $3`,
      [input.subscriptionId, input.status, input.customerId],
    );
  }
}
