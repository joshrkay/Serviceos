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
 * Idempotency is enforced per (invoiceId, amount, account-scope) so duplicate
 * POSTs from the public payment page don't create multiple intents, and a
 * tenant that later enables Connect does not collide with a prior platform
 * intent key.
 *
 * When `stripeAccountId` is set, the request is a Connect direct charge
 * (`Stripe-Account` header) so funds settle on the tenant's Express account.
 */

export interface StripePaymentIntentConfig {
  apiKey: string;
}

export interface CreatePaymentIntentInput {
  amount: number; // integer cents
  currency: string; // e.g. 'usd'
  invoiceId: string;
  tenantId: string;
  /** Connected account id for direct charges; omit for platform. */
  stripeAccountId?: string;
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

  const accountScope = input.stripeAccountId?.trim() || 'platform';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    // Idempotency-Key prevents duplicate intents when the customer
    // double-taps the pay button or the page remounts on iOS Safari.
    // Account scope keeps platform vs Connect intents distinct.
    'Idempotency-Key': `pi_${input.invoiceId}_${input.amount}_${accountScope}`,
  };
  if (input.stripeAccountId?.trim()) {
    headers['Stripe-Account'] = input.stripeAccountId.trim();
  }

  const res = await fetcher('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers,
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

// ─────────────────────────────────────────────────────────────────────────────
// P0-1 completion — discover + cancel minted PaymentIntents on invoice void.
//
// PI ids are NOT persisted locally at mint time (the client secret goes to the
// customer's browser and nothing else). What every invoice-purpose mint DOES
// do — here and in stripe-terminal.ts — is stamp `metadata[invoice_id]` and
// `metadata[tenant_id]` onto the Stripe object. Stripe's PaymentIntents
// Search API can query that metadata, which makes the ids durably
// discoverable without a schema change. Search has up to ~1 minute of index
// lag, so this is a best-effort sweep: anything it misses is still caught by
// the webhook's unapplied-capture audit.
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal PI shape returned by the search sweep. */
export interface PaymentIntentSummary {
  id: string;
  status: string;
}

interface StripeSearchResponse {
  data?: Array<{ id?: string; status?: string }>;
  has_more?: boolean;
  next_page?: string;
}

/** Defensive bound on search pagination — 10 pages × 100 PIs is far beyond
 * any plausible per-invoice mint count (mints are idempotency-keyed). */
const MAX_SEARCH_PAGES = 10;

/**
 * Find every PaymentIntent minted for an invoice in one account scope, via
 * `GET /v1/payment_intents/search` on `metadata[invoice_id]` +
 * `metadata[tenant_id]`. Scope matters: a PI lives on the account it was
 * minted under (platform, or the tenant's Connect account via the
 * `Stripe-Account` header) and a search only sees its own scope.
 */
export async function searchPaymentIntentsByInvoice(
  config: StripePaymentIntentConfig,
  input: { tenantId: string; invoiceId: string; stripeAccountId?: string },
  fetcher: StripeFetch = globalThis.fetch as unknown as StripeFetch,
): Promise<PaymentIntentSummary[]> {
  if (!config.apiKey) {
    throw new Error('searchPaymentIntentsByInvoice requires a Stripe API key');
  }
  if (!input.invoiceId) throw new Error('invoiceId is required');
  if (!input.tenantId) throw new Error('tenantId is required');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (input.stripeAccountId?.trim()) {
    headers['Stripe-Account'] = input.stripeAccountId.trim();
  }

  // Escape single quotes so a hostile id can't break out of the quoted
  // search clause (ids are uuids today; this is belt-and-braces).
  const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const query = `metadata['invoice_id']:'${esc(input.invoiceId)}' AND metadata['tenant_id']:'${esc(input.tenantId)}'`;

  const results: PaymentIntentSummary[] = [];
  let page: string | undefined;
  for (let i = 0; i < MAX_SEARCH_PAGES; i += 1) {
    const params = new URLSearchParams({ query, limit: '100' });
    if (page) params.set('page', page);
    const res = await fetcher(
      `https://api.stripe.com/v1/payment_intents/search?${params.toString()}`,
      { method: 'GET', headers, body: '' },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Stripe paymentIntents.search failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as StripeSearchResponse;
    for (const pi of data.data ?? []) {
      if (pi.id) results.push({ id: pi.id, status: pi.status ?? 'unknown' });
    }
    if (!data.has_more || !data.next_page) break;
    page = data.next_page;
  }
  return results;
}

/**
 * Cancel a minted PaymentIntent so its client secret can no longer capture
 * money (`POST /v1/payment_intents/:id/cancel`). Stripe rejects cancels on
 * terminal-state PIs — callers should skip `succeeded` / `canceled` and
 * treat other failures as best-effort (audit, never block).
 */
export async function cancelPaymentIntent(
  config: StripePaymentIntentConfig,
  paymentIntentId: string,
  stripeAccountId?: string,
  fetcher: StripeFetch = globalThis.fetch as unknown as StripeFetch,
): Promise<void> {
  if (!config.apiKey) throw new Error('cancelPaymentIntent requires a Stripe API key');
  if (!paymentIntentId) throw new Error('paymentIntentId is required');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (stripeAccountId?.trim()) {
    headers['Stripe-Account'] = stripeAccountId.trim();
  }

  const res = await fetcher(
    `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`,
    { method: 'POST', headers, body: '' },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Stripe paymentIntents.cancel failed (${res.status}): ${text}`);
  }
}
