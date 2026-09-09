import type { Pool } from 'pg';
import { AppError, ValidationError, NotFoundError } from '../shared/errors';

/**
 * Tier 4 (Subscription — Rivet billing). Service that mints Stripe
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

/**
 * Server-side plan allowlist for the onboarding trial checkout. The
 * browser only ever sends one of these ids — never a raw Stripe price —
 * so a compromised/buggy client can at worst pick the WRONG allowed plan,
 * never an arbitrary price. Each id maps to its own env var (never
 * STRIPE_PRICE_ID, the single legacy price) and expected monthly USD
 * amount, which `validatePlanPrice` checks against live Stripe data
 * before every checkout.
 */
export const BILLING_PLAN_IDS = ['basic', 'enterprise'] as const;
export type BillingPlanId = (typeof BILLING_PLAN_IDS)[number];

export interface BillingPlanView {
  id: BillingPlanId;
  /** Canonical Stripe product name, falling back to the plan's display name. */
  name: string;
  amountCents: number;
  currency: string;
  interval: string;
}

interface PlanSpec {
  envVar: string;
  expectedAmountCents: number;
  displayName: string;
}

const PLAN_SPECS: Record<BillingPlanId, PlanSpec> = {
  basic: { envVar: 'STRIPE_BASIC_PRICE_ID', expectedAmountCents: 5_000, displayName: 'Basic' },
  enterprise: { envVar: 'STRIPE_ENTERPRISE_PRICE_ID', expectedAmountCents: 15_000, displayName: 'Enterprise' },
};

/** Fails closed with a non-secret, actionable message — never the env value. */
function resolvePlanPriceId(planId: BillingPlanId): string {
  const spec = PLAN_SPECS[planId];
  const priceId = process.env[spec.envVar];
  if (!priceId) {
    throw new ValidationError(
      `Billing plan "${planId}" is not configured (${spec.envVar} is not set). Contact support.`,
    );
  }
  return priceId;
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

/**
 * Turns a failed "open the billing portal" Stripe REST call into an
 * operator-facing AppError while preserving the full Stripe reason in the
 * server logs. Mirrors `connectStripeFailure` in
 * `billing/stripe-connect.ts` ("fix(connect): surface Stripe onboarding
 * failures instead of masking them") — same class of bug, same fix shape:
 *
 * QA 2026-07-19 — POST /api/billing/portal-session returned a plain 500
 * for a tenant whose `tenants.stripe_customer_id` was stale (pointed at a
 * customer that no longer exists on the currently-configured Stripe
 * account/mode — e.g. a test-mode id under a live-mode key, or the
 * customer was deleted in the Dashboard). `getOrCreatePortalUrl` trusts
 * the cached id without verifying it — see `getOrCreateStripeCustomer`
 * below — so the failure only ever surfaced later, on the portal-session
 * POST itself, as a bare `throw new Error(...)`. `toErrorResponse`
 * flattened that to a generic 500 "An unexpected error occurred" with
 * nothing logged: Stripe's actual `resource_missing: "No such customer:
 * '...'"` reason reached neither the operator nor the server logs.
 *
 * We deliberately do NOT auto-recreate the Stripe customer here the way
 * `StripeConnectService.createOnboardingLink` lazily creates a missing
 * Account: `tenants.subscription_status` / `stripe_subscription_id` are
 * cached from the OLD customer, and silently rebinding
 * `stripe_customer_id` to a fresh, subscription-less customer would leave
 * those columns pointing at a subscription the new customer doesn't have
 * — an operator could keep full product access on a cached "active"
 * status that's no longer backed by anything in Stripe. That's a billing-
 * correctness call a human should make (confirm there's really no
 * matching Stripe subscription before rebinding), not something to paper
 * over automatically. Surfacing the real reason is the safe, contained
 * fix; recovery stays a human/operator action (#873 tracks it, including
 * the re-link of the affected tenant).
 *
 * #873 — so the web can render an actionable recovery state instead of a
 * dead-end toast, the stale-customer case is machine-readable: when the
 * failure is specifically the SAVED CUSTOMER being gone (not some other
 * `resource_missing`, e.g. a bad portal configuration id), `details`
 * carries `reason: 'stripe_customer_missing'` plus the stale
 * `stripeCustomerId` support needs for the re-link. The status stays 502:
 * the upstream dependency really did fail, and the pinned no-recreate
 * decision above means there is nothing the API can honestly succeed at.
 */
function billingPortalStripeFailure(
  context: string,
  status: number,
  rawBody: string,
  customerId?: string,
): AppError {
  let stripeMessage: string | undefined;
  let stripeCode: string | undefined;
  let stripeParam: string | undefined;
  try {
    const parsed = JSON.parse(rawBody) as {
      error?: { message?: string; code?: string; param?: string };
    } | null;
    stripeMessage = parsed?.error?.message?.trim() || undefined;
    stripeCode = parsed?.error?.code?.trim() || undefined;
    stripeParam = parsed?.error?.param?.trim() || undefined;
  } catch {
    /* Stripe normally returns JSON; keep the raw body for the log below. */
  }
  // eslint-disable-next-line no-console
  console.error(`[billing-subscription] ${context} failed (${status})`, {
    stripeCode,
    stripeMessage,
    ...(stripeMessage ? {} : { rawBody: rawBody.slice(0, 500) }),
  });
  // Only claim "the saved customer is gone" when Stripe says the missing
  // resource IS the customer — a resource_missing about, say, the portal
  // configuration must not send support down the re-link path.
  const customerMissing =
    stripeCode === 'resource_missing' &&
    (stripeParam === 'customer' || /no such customer/i.test(stripeMessage ?? ''));
  const hint = customerMissing
    ? ' The saved Stripe customer for this account no longer exists — contact support to re-link billing.'
    : '';
  const clientMessage = stripeMessage
    ? `Stripe couldn't open the billing portal: ${stripeMessage}${hint}`
    : `Stripe couldn't open the billing portal (HTTP ${status}). Check the API logs for details.`;
  return new AppError('BILLING_PORTAL_FAILED', clientMessage, 502, {
    stripeStatus: status,
    ...(stripeCode ? { stripeCode } : {}),
    ...(customerMissing
      ? {
          reason: 'stripe_customer_missing',
          ...(customerId ? { stripeCustomerId: customerId } : {}),
        }
      : {}),
  });
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

    // Reuse the tenant's single canonical Stripe customer so the portal
    // and trial-checkout paths both bind to the same id.
    const customerId = await this.getOrCreateStripeCustomer(tenantId, ownerEmail);

    // Mint the portal session.
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
      throw billingPortalStripeFailure(
        'portal session',
        sessionRes.status,
        await sessionRes.text(),
        customerId,
      );
    }
    const session = (await sessionRes.json()) as { url?: string };
    if (!session.url) {
      throw new Error('Stripe portal session returned no url');
    }
    return { url: session.url };
  }

  /**
   * Looks up a plan's Stripe price (with its product expanded) and checks
   * it is exactly what onboarding is allowed to charge: active, USD,
   * recurring monthly (interval_count 1 — never quarterly/annual),
   * licensed (never metered/usage-based — a metered price has no fixed
   * unit_amount to compare against and can't be sold as a flat-fee plan),
   * the expected amount, on an active product with a real (expanded)
   * product id. Never trusts the env-configured price id at face value —
   * a stale/wrong Stripe-side price must fail closed here rather than
   * silently checking out a tenant for the wrong amount, cadence, or
   * billing model.
   *
   * The lookup is bounded to 10s (AbortSignal.timeout) so a slow/hanging
   * Stripe response can't hang the onboarding billing-plans request or a
   * checkout attempt forever.
   *
   * Logs a safe structured diagnostic (phase, plan, Stripe status/request
   * id, and a shape summary) on any failure — no full response body, no
   * customer info, no keys.
   */
  private async validatePlanPrice(
    planId: BillingPlanId,
    priceId: string,
  ): Promise<{ priceId: string; productId: string; name: string; amountCents: number }> {
    const spec = PLAN_SPECS[planId];
    const apiKey = this.deps.config!.apiKey;
    const fetchFn = this.deps.fetchFn ?? fetch;
    const res = await fetchFn(
      `https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}?expand[]=product`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const requestId = res.headers?.get?.('request-id') ?? undefined;
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error('[billing-subscription] plan price lookup failed', {
        phase: 'plan_price_lookup',
        planId,
        stripeStatus: res.status,
        requestId,
      });
      throw new ValidationError(`Billing plan "${planId}" is misconfigured. Contact support.`);
    }
    const price = (await res.json()) as {
      active?: boolean;
      currency?: string;
      type?: string;
      unit_amount?: number | null;
      recurring?: { interval?: string; interval_count?: number; usage_type?: string } | null;
      product?: { id?: string; active?: boolean; name?: string } | string | null;
    };
    const product = price.product && typeof price.product === 'object' ? price.product : null;
    const productId = product?.id?.trim() || undefined;
    const valid =
      price.active === true &&
      price.currency === 'usd' &&
      price.type === 'recurring' &&
      price.recurring?.interval === 'month' &&
      price.recurring?.interval_count === 1 &&
      price.recurring?.usage_type === 'licensed' &&
      price.unit_amount === spec.expectedAmountCents &&
      product?.active === true &&
      Boolean(productId);
    if (!valid) {
      // eslint-disable-next-line no-console
      console.error('[billing-subscription] plan price failed validation', {
        phase: 'plan_price_validation',
        planId,
        requestId,
        active: price.active,
        currency: price.currency,
        type: price.type,
        interval: price.recurring?.interval,
        intervalCount: price.recurring?.interval_count,
        usageType: price.recurring?.usage_type,
        unitAmount: price.unit_amount,
        productActive: product?.active,
        productIdPresent: Boolean(productId),
      });
      throw new ValidationError(
        `Billing plan "${planId}" is misconfigured (expected an active, USD, monthly ` +
          `(not quarterly/annual), licensed (not metered) $${(spec.expectedAmountCents / 100).toFixed(2)} ` +
          `price on an active product). Contact support.`,
      );
    }
    return {
      priceId,
      productId: productId!,
      name: product?.name?.trim() || spec.displayName,
      amountCents: spec.expectedAmountCents,
    };
  }

  /**
   * Validated, display-safe view of the sellable plans (basic/enterprise)
   * for the onboarding billing step. Only ids whose env var is set AND
   * whose Stripe price passes `validatePlanPrice` are included — a
   * misconfigured plan is omitted (and logged) rather than shown broken
   * or charged wrong. No secrets in the response (price ids are not
   * secret, but are omitted anyway — the frontend only needs id/name/amount).
   */
  async listPlans(): Promise<{ plans: BillingPlanView[] }> {
    if (!this.deps.config?.apiKey) {
      throw new ValidationError('Subscription billing is not configured');
    }
    const plans: BillingPlanView[] = [];
    for (const planId of BILLING_PLAN_IDS) {
      let priceId: string;
      try {
        priceId = resolvePlanPriceId(planId);
      } catch {
        continue;
      }
      try {
        const validated = await this.validatePlanPrice(planId, priceId);
        plans.push({
          id: planId,
          name: validated.name,
          amountCents: validated.amountCents,
          currency: 'usd',
          interval: 'month',
        });
      } catch {
        continue;
      }
    }
    return { plans };
  }

  /**
   * Creates a Stripe Checkout Session for a 14-day trial subscription.
   * The operator is redirected to Stripe-hosted checkout where they
   * enter card details. Trial starts immediately; billing begins after
   * 14 days.
   *
   * `planId` (basic|enterprise) is the ONLY caller-controlled plan
   * selection: the price id is resolved server-side from the matching
   * STRIPE_<PLAN>_PRICE_ID env var and validated live against Stripe
   * (see `validatePlanPrice`) — a caller can never point checkout at an
   * arbitrary Stripe price. Omitting `planId` keeps the legacy,
   * DEPRECATED single-price path (STRIPE_PRICE_ID, unvalidated — no
   * live Stripe check, no plan/product metadata) alive only for
   * `scripts/provision-tenant.ts`; the HTTP route always supplies
   * `planId` and never exercises this branch.
   */
  async createTrialCheckoutSession(input: {
    tenantId: string;
    ownerEmail: string;
    successUrl: string;
    cancelUrl: string;
    planId?: BillingPlanId;
  }): Promise<{ url: string }> {
    if (!this.deps.config?.apiKey) {
      throw new ValidationError('Subscription billing is not configured');
    }
    let priceId: string;
    let validatedPlan: { productId: string } | null = null;
    if (input.planId) {
      const resolved = resolvePlanPriceId(input.planId);
      const validated = await this.validatePlanPrice(input.planId, resolved);
      priceId = validated.priceId;
      validatedPlan = { productId: validated.productId };
    } else {
      // DEPRECATED legacy path — see docstring above.
      const legacy = process.env.STRIPE_PRICE_ID;
      if (!legacy) {
        throw new ValidationError('STRIPE_PRICE_ID is not set');
      }
      priceId = legacy;
    }
    const fetchFn = this.deps.fetchFn ?? fetch;

    // Serialize trial checkout per tenant via a Postgres advisory
    // transaction lock. Without this, two callers that ran the
    // subscription_status check at the same time (two tabs, retry
    // while a webhook is delayed) could both pass the gate, both reach
    // Stripe, and both mint a subscription on the SAME customer —
    // billing the operator twice on day 15. With the lock, only one
    // checkout per tenant is in flight at a time; the second caller
    // gets a clear "in progress" error and can retry once the first
    // finishes.
    //
    // Lock is held until the Stripe checkout session is minted, then
    // released at COMMIT. Residual race window remains for callers
    // arriving after the COMMIT but before the
    // customer.subscription.created webhook lands; that's typically
    // sub-second. A follow-up will add belt-and-suspenders
    // compensating cancellation in the subscription webhook handler.
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');

      const lockRes = await client.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS locked`,
        [input.tenantId],
      );
      if (!lockRes.rows[0]?.locked) {
        throw new ValidationError(
          'A checkout is already in progress for this tenant. Wait a moment and try again.',
        );
      }

      // Re-check status INSIDE the lock. Two signals refuse a new
      // checkout:
      //   (1) subscription_status reflects a live subscription — a
      //       prior checkout completed and its webhook landed;
      //   (2) pending_checkout_at is recent (<30 min) — a prior
      //       checkout minted a Stripe session that is still
      //       outstanding. This closes the residual race the lock
      //       alone left open: the previous caller already released
      //       the lock at COMMIT, but its subscription.created
      //       webhook hasn't fired yet so subscription_status is
      //       still null. The pending timestamp survives lock
      //       release until either the webhook clears it or the
      //       30-min timeout expires for an abandoned checkout.
      const statusRows = await client.query<{
        subscription_status: string | null;
        pending_checkout_at: Date | null;
      }>(
        `SELECT subscription_status, pending_checkout_at
           FROM tenants WHERE id = $1`,
        [input.tenantId],
      );
      const existingStatus = statusRows.rows[0]?.subscription_status ?? null;
      if (existingStatus === 'trialing' || existingStatus === 'active' || existingStatus === 'past_due') {
        throw new ValidationError(
          'A subscription is already active for this tenant. Manage it from Settings → Billing.',
        );
      }
      const pendingAt = statusRows.rows[0]?.pending_checkout_at ?? null;
      if (pendingAt) {
        const ageMs = Date.now() - new Date(pendingAt).getTime();
        // Match the Stripe expires_at headroom (32 min) so the gate
        // never reopens while the previous session could still be
        // completed from browser history.
        if (ageMs < 32 * 60 * 1000) {
          throw new ValidationError(
            'A checkout was just started for this tenant. Complete it or wait a moment before trying again.',
          );
        }
      }

      // Reuse the tenant's single canonical Stripe customer so two
      // concurrent / retried checkouts never produce two different
      // customers (one of which would have a subscription invisible
      // to the in-app billing portal). getOrCreateStripeCustomer
      // queries through the pool, not this client — that's
      // intentional: customer creation persists independently of the
      // checkout transaction, so a rollback here doesn't unbind a
      // customer that Stripe already minted.
      const customerId = await this.getOrCreateStripeCustomer(
        input.tenantId,
        input.ownerEmail,
      );

      const body = new URLSearchParams();
      body.set('mode', 'subscription');
      body.set('line_items[0][price]', priceId);
      body.set('line_items[0][quantity]', '1');
      body.set('subscription_data[trial_period_days]', '14');
      body.set('subscription_data[metadata][tenant_id]', input.tenantId);
      if (input.planId && validatedPlan) {
        body.set('subscription_data[metadata][plan_id]', input.planId);
        body.set('subscription_data[metadata][stripe_price_id]', priceId);
        body.set('subscription_data[metadata][stripe_product_id]', validatedPlan.productId);
      }
      body.set('payment_method_collection', 'always');
      // Collect name + billing address on the Stripe-hosted page. We
      // already pass an existing `customer` (created with just an email),
      // so `customer_update` must explicitly opt each field in — without
      // it Checkout silently skips both fields for a pre-existing customer.
      body.set('billing_address_collection', 'required');
      body.set('customer_update[name]', 'auto');
      body.set('customer_update[address]', 'auto');
      body.set('customer', customerId);
      body.set('success_url', input.successUrl);
      body.set('cancel_url', input.cancelUrl);
      body.set('client_reference_id', input.tenantId);
      // Bind the Stripe session lifetime to the gate's staleness
      // ceiling so a session can't outlive pending_checkout_at.
      // Stripe's minimum expires_at is 30 minutes from now — we send
      // 32 min so positive clock skew or a slow Stripe-side parse
      // can't push our value below the minimum and reject the
      // request. PENDING_CHECKOUT_STALE_MS matches.
      const expiresAt = Math.floor(Date.now() / 1000) + 32 * 60;
      body.set('expires_at', String(expiresAt));
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
        // eslint-disable-next-line no-console
        console.error('[billing-subscription] checkout session create failed', {
          phase: 'checkout_session_create',
          planId: input.planId ?? null,
          stripeStatus: res.status,
          requestId: res.headers?.get?.('request-id') ?? undefined,
        });
        throw new Error(`Stripe checkout session failed (${res.status}): ${text}`);
      }
      const session = (await res.json()) as { id?: string; url?: string };
      if (!session.url) {
        throw new Error('Stripe checkout session returned no url');
      }

      // Stamp the pending-checkout timestamp AND the Stripe session id
      // INSIDE the lock so a racing follower sees both the moment they
      // acquire the lock. The session id is what /billing/cancel hands
      // to Stripe's expire endpoint — cancel_url can't carry it back to
      // us because Stripe only interpolates {CHECKOUT_SESSION_ID} into
      // success_url, not cancel_url. Cleared by the
      // subscription.created webhook (success path) or by /billing/cancel
      // (cancel path); the 32-min staleness check handles abandoned
      // sessions.
      await client.query(
        `UPDATE tenants
            SET pending_checkout_at = NOW(),
                pending_checkout_session_id = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [input.tenantId, session.id ?? null],
      );

      await client.query('COMMIT');
      return { url: session.url };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* best-effort — connection may already be in an unknown state */
      }
      throw err;
    } finally {
      client.release();
    }
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
    /** Mirror of the Stripe subscription's trial_end; null clears it. Drives
     * the trial-reminder sweep. Omit to leave the cached value untouched. */
    trialEndsAt?: Date | null;
  }): Promise<void> {
    if (input.trialEndsAt !== undefined) {
      await this.deps.pool.query(
        `UPDATE tenants
         SET stripe_subscription_id = $1, subscription_status = $2,
             trial_ends_at = $3, updated_at = NOW()
         WHERE stripe_customer_id = $4`,
        [input.subscriptionId, input.status, input.trialEndsAt, input.customerId],
      );
      return;
    }
    await this.deps.pool.query(
      `UPDATE tenants
       SET stripe_subscription_id = $1, subscription_status = $2, updated_at = NOW()
       WHERE stripe_customer_id = $3`,
      [input.subscriptionId, input.status, input.customerId],
    );
  }

  /**
   * Clears tenants.pending_checkout_at so the trial-checkout gate
   * reopens. Called when the operator returns via Stripe's cancel_url.
   *
   * The session id is read from tenants.pending_checkout_session_id
   * (persisted at create time) rather than trusting the client — Stripe
   * only interpolates {CHECKOUT_SESSION_ID} into success_url, so we
   * can't get the id back via the cancel redirect. When the persisted
   * id is non-null, the server POSTs Stripe's expire endpoint BEFORE
   * clearing the marker — without that, the operator could re-open the
   * original Stripe URL from browser history and complete the old
   * session AFTER opening a new one, creating two subscriptions.
   *
   * 404 from Stripe (session already expired/canceled) is treated as
   * success — the goal state is reached. Any other non-OK leaves the
   * marker stamped so the gate continues to refuse new checkouts until
   * the staleness ceiling drops it naturally.
   *
   * KNOWN LIMITATION (deferred post-soft-launch): this always acts on
   * the tenant's CURRENT pending session. If checkout A goes stale,
   * the operator opens checkout B, and a stale tab / history entry
   * from A then follows its cancel_url, B's session is expired and
   * its marker cleared. The proper fix is a per-checkout cancellation
   * token persisted alongside session id and verified here before
   * acting. Soft-launch consequence: operator clicks Start Trial
   * again and gets a fresh session — annoying but recoverable. Track
   * in a follow-up issue.
   */
  async clearPendingCheckout(tenantId: string): Promise<void> {
    const { rows } = await this.deps.pool.query<{
      pending_checkout_session_id: string | null;
    }>(
      `SELECT pending_checkout_session_id FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const sessionId = rows[0]?.pending_checkout_session_id ?? null;

    if (sessionId && this.deps.config?.apiKey) {
      const fetchFn = this.deps.fetchFn ?? fetch;
      const res = await fetchFn(
        `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.deps.config.apiKey}`,
          },
        },
      );
      if (!res.ok && res.status !== 404) {
        const body = await res.text();
        throw new Error(`Stripe session expire failed (${res.status}): ${body}`);
      }
    }

    await this.deps.pool.query(
      `UPDATE tenants
          SET pending_checkout_at = NULL,
              pending_checkout_session_id = NULL,
              updated_at = NOW()
        WHERE id = $1
          AND (pending_checkout_at IS NOT NULL OR pending_checkout_session_id IS NOT NULL)`,
      [tenantId],
    );
  }

  /**
   * Single canonical Stripe customer per tenant. Used by both the trial
   * checkout and billing-portal paths so concurrent or retried
   * checkouts never produce two different Stripe customers (one of
   * which would carry a subscription invisible to the in-app portal).
   *
   * Race-tolerant: when two callers see stripe_customer_id IS NULL at
   * the same time, each POSTs a new Stripe customer, but only the
   * first UPDATE wins. The losing caller re-reads the winner's id and
   * uses it. The losing call's Stripe customer becomes a no-op orphan
   * — it has no subscription, no payment method, and Stripe doesn't
   * bill empty customers.
   */
  private async getOrCreateStripeCustomer(
    tenantId: string,
    ownerEmail: string,
  ): Promise<string> {
    if (!this.deps.config?.apiKey) {
      throw new ValidationError('Subscription billing is not configured');
    }
    const apiKey = this.deps.config.apiKey;
    const fetchFn = this.deps.fetchFn ?? fetch;

    const { rows } = await this.deps.pool.query(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (rows.length === 0) throw new NotFoundError('Tenant', tenantId);
    const existing = (rows[0] as Record<string, unknown>).stripe_customer_id as
      | string
      | null;
    if (existing) return existing;

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

    // Conditional UPDATE: only claim the column when still NULL so a
    // concurrent get-or-create never overwrites a winning customer id.
    const updateRes = await this.deps.pool.query<{ stripe_customer_id: string }>(
      `UPDATE tenants
          SET stripe_customer_id = $1, updated_at = NOW()
        WHERE id = $2 AND stripe_customer_id IS NULL
        RETURNING stripe_customer_id`,
      [customer.id, tenantId],
    );
    if (updateRes.rows.length > 0) {
      return updateRes.rows[0].stripe_customer_id;
    }

    // Lost the race — re-read what the winner persisted.
    const reread = await this.deps.pool.query<{ stripe_customer_id: string }>(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const winner = reread.rows[0]?.stripe_customer_id;
    if (!winner) {
      throw new Error('getOrCreateStripeCustomer: lost race but no winner persisted');
    }
    return winner;
  }
}
