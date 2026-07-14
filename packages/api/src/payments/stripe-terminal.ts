/**
 * Stripe Terminal helpers — Connect direct charges (card_present).
 *
 * Online PaymentIntents use automatic_payment_methods and omit
 * payment_method_types. Terminal is the documented exception: intents must
 * pass payment_method_types[]=card_present. Connection tokens and intents
 * are always created on the tenant Connect account (Stripe-Account header).
 */
import { StripeFetch } from './stripe-payment-intent';

export interface StripeTerminalConfig {
  apiKey: string;
  stripeAccountId: string;
}

export interface CreateConnectionTokenResult {
  secret: string;
}

export interface CreateTerminalPaymentIntentInput {
  amount: number;
  currency: string;
  tenantId: string;
  invoiceId?: string;
  jobId?: string;
  /** Discriminator for webhook / ledger routing. */
  purpose: 'invoice' | 'deposit';
}

export interface CreateTerminalPaymentIntentResult {
  clientSecret: string;
  paymentIntentId: string;
}

function buildHeaders(
  config: StripeTerminalConfig,
  idempotencyKey?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Account': config.stripeAccountId,
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return headers;
}

export async function createTerminalConnectionToken(
  config: StripeTerminalConfig,
  fetcher: StripeFetch = globalThis.fetch as unknown as StripeFetch,
): Promise<CreateConnectionTokenResult> {
  if (!config.apiKey) throw new Error('createTerminalConnectionToken requires a Stripe API key');
  if (!config.stripeAccountId?.trim()) {
    throw new Error('createTerminalConnectionToken requires stripeAccountId');
  }

  const res = await fetcher('https://api.stripe.com/v1/terminal/connection_tokens', {
    method: 'POST',
    headers: buildHeaders(config),
    body: '',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Stripe terminal.connectionTokens.create failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { secret?: string };
  if (!data.secret) {
    throw new Error('Stripe connection token response missing secret');
  }
  return { secret: data.secret };
}

/**
 * Create a card-present PaymentIntent on the connected account.
 * Amount must be server-derived integer cents.
 */
export async function createTerminalPaymentIntent(
  config: StripeTerminalConfig,
  input: CreateTerminalPaymentIntentInput,
  fetcher: StripeFetch = globalThis.fetch as unknown as StripeFetch,
): Promise<CreateTerminalPaymentIntentResult> {
  if (!config.apiKey) throw new Error('createTerminalPaymentIntent requires a Stripe API key');
  if (!config.stripeAccountId?.trim()) {
    throw new Error('createTerminalPaymentIntent requires stripeAccountId');
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error('amount must be a positive integer in cents');
  }
  if (!input.currency) throw new Error('currency is required');
  if (!input.tenantId) throw new Error('tenantId is required');
  if (input.purpose === 'invoice' && !input.invoiceId) {
    throw new Error('invoiceId is required for invoice purpose');
  }
  if (input.purpose === 'deposit' && !input.jobId) {
    throw new Error('jobId is required for deposit purpose');
  }

  const scopeKey =
    input.purpose === 'invoice'
      ? `inv_${input.invoiceId}`
      : `dep_${input.jobId}`;
  const idempotencyKey = `term_pi_${scopeKey}_${input.amount}_${config.stripeAccountId}`;

  const body = new URLSearchParams({
    amount: String(input.amount),
    currency: input.currency,
    'payment_method_types[]': 'card_present',
    capture_method: 'automatic',
    'metadata[tenant_id]': input.tenantId,
    'metadata[collection]': 'terminal',
  });
  if (input.invoiceId) body.set('metadata[invoice_id]', input.invoiceId);
  if (input.jobId && input.purpose === 'deposit') {
    body.set('metadata[deposit_for_job_id]', input.jobId);
  }

  const res = await fetcher('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: buildHeaders(config, idempotencyKey),
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Stripe terminal paymentIntents.create failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { id?: string; client_secret?: string };
  if (!data.id || !data.client_secret) {
    throw new Error('Stripe terminal paymentIntent response missing id or client_secret');
  }
  return { clientSecret: data.client_secret, paymentIntentId: data.id };
}
