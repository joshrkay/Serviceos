/**
 * P5-016 — Stripe PaymentIntent wrapper.
 *
 * Thin wrapper around Stripe's `POST /v1/payment_intents` REST endpoint.
 * Mirrors the fetch-based pattern in `stripe-payment-link.ts` so we don't
 * pull in the full Stripe SDK as a dependency. The PaymentIntent flow runs
 * in parallel to the existing PaymentLink flow — card data goes directly
 * from the customer's browser into Stripe's iframe (`<PaymentElement>`),
 * never through our server.
 *
 * Idempotency is enforced per (invoiceId, amount) so duplicate POSTs from
 * the public payment page don't create multiple intents.
 */

export interface StripePaymentIntentConfig {
  apiKey: string;
}

export interface CreatePaymentIntentInput {
  amount: number; // integer cents
  currency: string; // e.g. 'usd'
  invoiceId: string;
  tenantId: string;
}

export interface CreatePaymentIntentResult {
  clientSecret: string;
  paymentIntentId: string;
}

/**
 * Minimal HTTP shape we expect back from Stripe's PaymentIntent create.
 * Defined locally to avoid a Stripe SDK dependency.
 */
interface StripePaymentIntentResponse {
  id?: string;
  client_secret?: string;
}

export interface StripeFetch {
  (input: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
    json(): Promise<unknown>;
  }>;
}

/**
 * Create a Stripe PaymentIntent and return the client secret.
 *
 * @param config Stripe API config (live or test secret key).
 * @param input  Amount, currency, invoice + tenant ids.
 * @param fetcher Optional fetch impl — injectable for tests.
 */
export async function createPaymentIntent(
  config: StripePaymentIntentConfig,
  input: CreatePaymentIntentInput,
  fetcher: StripeFetch = globalThis.fetch as unknown as StripeFetch,
): Promise<CreatePaymentIntentResult> {
  if (!config.apiKey) {
    throw new Error('createPaymentIntent requires a Stripe API key');
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error('amount must be a positive integer in cents');
  }
  if (!input.currency) {
    throw new Error('currency is required');
  }
  if (!input.invoiceId) {
    throw new Error('invoiceId is required');
  }
  if (!input.tenantId) {
    throw new Error('tenantId is required');
  }

  const body = new URLSearchParams({
    amount: String(input.amount),
    currency: input.currency,
    'automatic_payment_methods[enabled]': 'true',
    'metadata[invoice_id]': input.invoiceId,
    'metadata[tenant_id]': input.tenantId,
  });

  const res = await fetcher('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Idempotency-Key prevents duplicate intents when the customer
      // double-taps the pay button or the page remounts on iOS Safari.
      'Idempotency-Key': `pi_${input.invoiceId}_${input.amount}`,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Stripe paymentIntents.create failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as StripePaymentIntentResponse;
  if (!data.id || !data.client_secret) {
    throw new Error('Stripe paymentIntent response missing id or client_secret');
  }
  return { clientSecret: data.client_secret, paymentIntentId: data.id };
}
