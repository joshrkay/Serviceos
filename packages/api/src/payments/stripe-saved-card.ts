/**
 * #6 phase 4 — Stripe wrappers for saved-card / off-session dues billing.
 *
 * Fetch-based (no Stripe SDK), mirroring stripe-payment-intent.ts. Every call
 * is Connect-aware: when `stripeAccountId` is set, the `Stripe-Account` header
 * scopes the Customer / SetupIntent / PaymentMethod to the tenant's connected
 * account, so a card saved via SetupIntent can later be charged off-session on
 * the SAME account. Card data never touches our server — the SetupIntent client
 * secret is confirmed browser-side in Stripe Elements.
 */
import { StripeFetch } from './stripe-payment-intent';

export interface StripeAccountConfig {
  apiKey: string;
  /** Tenant's connected account id; omit for platform-account calls. */
  stripeAccountId?: string;
}

interface StripeCustomerResponse {
  id?: string;
}
interface StripeSetupIntentResponse {
  id?: string;
  client_secret?: string;
}
interface StripePaymentMethodResponse {
  id?: string;
  card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number };
}
interface StripePaymentIntentResponse {
  id?: string;
  status?: string;
  error?: {
    message?: string;
    code?: string;
    decline_code?: string;
    payment_intent?: { id?: string; status?: string };
  };
}

function buildHeaders(config: StripeAccountConfig, idempotencyKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (config.stripeAccountId) headers['Stripe-Account'] = config.stripeAccountId;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return headers;
}

export interface CreateSetupIntentInput {
  tenantId: string;
  customerId: string;
  /** Reuse an existing Stripe customer (one per (tenant,customer)); created if absent. */
  stripeCustomerId?: string;
  email?: string;
  name?: string;
}

export interface CreateSetupIntentResult {
  clientSecret: string;
  setupIntentId: string;
  stripeCustomerId: string;
}

/**
 * Create (or reuse) a connected-account Stripe Customer and a SetupIntent so
 * the customer can save a card. The SetupIntent carries tenant/customer ids in
 * metadata so the `setup_intent.succeeded` webhook can resolve and persist the
 * resulting PaymentMethod.
 */
export async function createSetupIntent(
  config: StripeAccountConfig,
  input: CreateSetupIntentInput,
  fetcher: StripeFetch = globalThis.fetch as unknown as StripeFetch,
): Promise<CreateSetupIntentResult> {
  if (!config.apiKey) throw new Error('createSetupIntent requires a Stripe API key');
  if (!input.tenantId) throw new Error('tenantId is required');
  if (!input.customerId) throw new Error('customerId is required');

  let stripeCustomerId = input.stripeCustomerId;
  if (!stripeCustomerId) {
    const customerParams: Record<string, string> = {
      'metadata[tenant_id]': input.tenantId,
      'metadata[customer_id]': input.customerId,
    };
    if (input.email) customerParams.email = input.email;
    if (input.name) customerParams.name = input.name;
    const res = await fetcher('https://api.stripe.com/v1/customers', {
      method: 'POST',
      headers: buildHeaders(config),
      body: new URLSearchParams(customerParams).toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Stripe customers.create failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as StripeCustomerResponse;
    if (!data.id) throw new Error('Stripe customer response missing id');
    stripeCustomerId = data.id;
  }

  const res = await fetcher('https://api.stripe.com/v1/setup_intents', {
    method: 'POST',
    headers: buildHeaders(config),
    body: new URLSearchParams({
      customer: stripeCustomerId,
      usage: 'off_session',
      'payment_method_types[]': 'card',
      'metadata[tenant_id]': input.tenantId,
      'metadata[customer_id]': input.customerId,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Stripe setupIntents.create failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as StripeSetupIntentResponse;
  if (!data.id || !data.client_secret) {
    throw new Error('Stripe setupIntent response missing id or client_secret');
  }
  return { clientSecret: data.client_secret, setupIntentId: data.id, stripeCustomerId };
}

export interface PaymentMethodDetails {
  id: string;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
}

/** Retrieve a PaymentMethod's display metadata (brand/last4/expiry). */
export async function retrievePaymentMethod(
  config: StripeAccountConfig,
  paymentMethodId: string,
  fetcher: StripeFetch = globalThis.fetch as unknown as StripeFetch,
): Promise<PaymentMethodDetails> {
  if (!config.apiKey) throw new Error('retrievePaymentMethod requires a Stripe API key');
  if (!paymentMethodId) throw new Error('paymentMethodId is required');
  const res = await fetcher(
    `https://api.stripe.com/v1/payment_methods/${encodeURIComponent(paymentMethodId)}`,
    { method: 'GET', headers: buildHeaders(config), body: '' },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Stripe paymentMethods.retrieve failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as StripePaymentMethodResponse;
  return {
    id: data.id ?? paymentMethodId,
    brand: data.card?.brand,
    last4: data.card?.last4,
    expMonth: data.card?.exp_month,
    expYear: data.card?.exp_year,
  };
}

export type OffSessionChargeStatus = 'succeeded' | 'processing' | 'requires_action' | 'failed';

export interface OffSessionChargeResult {
  status: OffSessionChargeStatus;
  paymentIntentId?: string;
  declineCode?: string;
  errorMessage?: string;
}

export interface ChargeOffSessionInput {
  amount: number; // integer cents
  currency: string;
  stripeCustomerId: string;
  paymentMethodId: string;
  /** Stable key so a retried sweep can't double-charge the same cycle. */
  idempotencyKey: string;
  metadata?: Record<string, string>;
}

/**
 * Charge a saved card off-session. Returns a structured result rather than
 * throwing on a decline / authentication_required, so the dues sweep can fall
 * back to a payable invoice instead of crashing. Only true transport/config
 * errors throw.
 */
export async function chargeOffSession(
  config: StripeAccountConfig,
  input: ChargeOffSessionInput,
  fetcher: StripeFetch = globalThis.fetch as unknown as StripeFetch,
): Promise<OffSessionChargeResult> {
  if (!config.apiKey) throw new Error('chargeOffSession requires a Stripe API key');
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error('amount must be a positive integer in cents');
  }
  if (!input.currency) throw new Error('currency is required');
  if (!input.stripeCustomerId) throw new Error('stripeCustomerId is required');
  if (!input.paymentMethodId) throw new Error('paymentMethodId is required');
  if (!input.idempotencyKey) throw new Error('idempotencyKey is required');

  const params: Record<string, string> = {
    amount: String(input.amount),
    currency: input.currency,
    customer: input.stripeCustomerId,
    payment_method: input.paymentMethodId,
    off_session: 'true',
    confirm: 'true',
  };
  for (const [k, v] of Object.entries(input.metadata ?? {})) {
    params[`metadata[${k}]`] = v;
  }

  const res = await fetcher('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: buildHeaders(config, input.idempotencyKey),
    body: new URLSearchParams(params).toString(),
  });
  // Read the body once as text, then parse — so a non-JSON error body (gateway
  // 502, proxy HTML) is preserved for diagnostics instead of collapsing to {}.
  const rawText = await res.text().catch(() => '');
  let data: StripePaymentIntentResponse = {};
  try {
    if (rawText) data = JSON.parse(rawText) as StripePaymentIntentResponse;
  } catch {
    // Non-JSON body — keep rawText for the error message below.
  }

  if (!res.ok) {
    // Card declined or off-session authentication required. Stripe returns the
    // PaymentIntent inside `error` for card_error cases.
    const err = data.error;
    return {
      status: err?.payment_intent?.status === 'requires_action' ? 'requires_action' : 'failed',
      paymentIntentId: err?.payment_intent?.id,
      declineCode: err?.decline_code ?? err?.code,
      errorMessage: err?.message ?? (rawText ? `Stripe HTTP ${res.status}: ${rawText.slice(0, 200)}` : undefined),
    };
  }

  const status: OffSessionChargeStatus =
    data.status === 'succeeded'
      ? 'succeeded'
      : data.status === 'processing'
        ? 'processing'
        : data.status === 'requires_action'
          ? 'requires_action'
          : 'failed';
  return { status, paymentIntentId: data.id };
}
