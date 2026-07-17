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

export interface CreateTerminalSessionResult {
  secret: string;
  locationId: string;
  /** True when a new Stripe Terminal Location was created this call. */
  locationCreated: boolean;
}

export interface CreateTerminalSessionInput {
  displayName: string;
  existingLocationId?: string | null;
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

export interface TerminalLocationAddress {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
}

export interface EnsureTerminalLocationInput {
  displayName: string;
  address: TerminalLocationAddress;
  /** Previously persisted location id, if any. */
  existingLocationId?: string | null;
}

/**
 * Create (or reuse) a Terminal Location on the connected account.
 * Required before Tap to Pay / reader connect.
 */
export async function ensureTerminalLocation(
  config: StripeTerminalConfig,
  input: EnsureTerminalLocationInput,
  fetcher: StripeFetch = globalThis.fetch as unknown as StripeFetch,
): Promise<{ locationId: string }> {
  if (!config.apiKey) throw new Error('ensureTerminalLocation requires a Stripe API key');
  if (!config.stripeAccountId?.trim()) {
    throw new Error('ensureTerminalLocation requires stripeAccountId');
  }
  if (input.existingLocationId?.trim()) {
    return { locationId: input.existingLocationId.trim() };
  }
  if (!input.displayName.trim()) throw new Error('displayName is required');
  if (!input.address.line1 || !input.address.city || !input.address.postalCode || !input.address.country) {
    throw new Error('address line1, city, postalCode, and country are required');
  }

  const body = new URLSearchParams({
    display_name: input.displayName.trim(),
    'address[line1]': input.address.line1,
    'address[city]': input.address.city,
    'address[postal_code]': input.address.postalCode,
    'address[country]': input.address.country.toUpperCase(),
  });
  if (input.address.line2) body.set('address[line2]', input.address.line2);
  if (input.address.state) body.set('address[state]', input.address.state);

  const res = await fetcher('https://api.stripe.com/v1/terminal/locations', {
    method: 'POST',
    headers: buildHeaders(config),
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Stripe terminal.locations.create failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error('Stripe location response missing id');
  return { locationId: data.id };
}

/**
 * Read the connected account's business address for Terminal Location creation.
 */
export async function fetchConnectAccountBusinessAddress(
  apiKey: string,
  accountId: string,
  fetcher: StripeFetch = globalThis.fetch as unknown as StripeFetch,
): Promise<TerminalLocationAddress | null> {
  const res = await fetcher(`https://api.stripe.com/v1/accounts/${accountId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: '',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Stripe accounts.retrieve failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    company?: { address?: Record<string, string | null> };
    individual?: { address?: Record<string, string | null> };
    business_profile?: { support_address?: Record<string, string | null> };
  };
  const raw =
    data.company?.address ??
    data.individual?.address ??
    data.business_profile?.support_address ??
    null;
  if (!raw?.line1 || !raw.city || !raw.postal_code || !raw.country) return null;
  return {
    line1: raw.line1,
    line2: raw.line2 ?? undefined,
    city: raw.city,
    state: raw.state ?? undefined,
    postalCode: raw.postal_code,
    country: raw.country,
  };
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
 * Ensure a Terminal Location exists on the Connect account, then mint a
 * connection token. Location address comes from the connected account's
 * business profile; missing address → TERMINAL_LOCATION_ADDRESS_REQUIRED.
 */
export async function createTerminalSession(
  config: StripeTerminalConfig,
  input: CreateTerminalSessionInput,
  fetcher: StripeFetch = globalThis.fetch as unknown as StripeFetch,
): Promise<CreateTerminalSessionResult> {
  const existing = input.existingLocationId?.trim() || null;
  let locationId = existing;
  let locationCreated = false;

  if (!locationId) {
    const address = await fetchConnectAccountBusinessAddress(
      config.apiKey,
      config.stripeAccountId,
      fetcher,
    );
    if (!address) {
      throw Object.assign(
        new Error(
          'Connect account needs a business address before Terminal can be used. Complete business details in Stripe onboarding.',
        ),
        { code: 'TERMINAL_LOCATION_ADDRESS_REQUIRED' },
      );
    }
    const created = await ensureTerminalLocation(
      config,
      {
        displayName: input.displayName.trim() || 'Field location',
        address,
      },
      fetcher,
    );
    locationId = created.locationId;
    locationCreated = true;
  }

  const { secret } = await createTerminalConnectionToken(config, fetcher);
  return { secret, locationId, locationCreated };
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
