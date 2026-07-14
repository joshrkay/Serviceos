import type { AuthedFetch } from './me';

export class TerminalApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'TerminalApiError';
  }
}

export interface TerminalConnectionToken {
  secret: string;
  locationId: string;
  stripeAccountId: string;
}

export interface TerminalPaymentIntent {
  clientSecret: string;
  paymentIntentId: string;
  stripeAccountId: string;
  amountCents: number;
  currency: string;
  invoiceId: string;
}

async function readError(res: Response): Promise<TerminalApiError> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
  };
  return new TerminalApiError(
    body.message ?? `Terminal API error ${res.status}`,
    body.error ?? 'UNKNOWN',
    res.status,
  );
}

export async function createTerminalConnectionToken(
  client: AuthedFetch,
): Promise<TerminalConnectionToken> {
  const res = await client('/api/terminal/connection-token', { method: 'POST' });
  if (!res.ok) throw await readError(res);
  const data = (await res.json()) as TerminalConnectionToken;
  if (!data.secret || !data.locationId) {
    throw new TerminalApiError(
      'Connection token response missing secret or locationId',
      'INVALID_RESPONSE',
      502,
    );
  }
  return data;
}

export async function createTerminalPaymentIntent(
  client: AuthedFetch,
  invoiceId: string,
): Promise<TerminalPaymentIntent> {
  const res = await client('/api/terminal/payment-intents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invoiceId }),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as TerminalPaymentIntent;
}

/**
 * Prepare a Terminal collect session: connection token (+ location) +
 * card_present PI. Native Stripe Terminal SDK uses these to collect/confirm
 * on-device. Settlement is webhook-driven.
 */
export async function prepareTerminalCollect(
  client: AuthedFetch,
  invoiceId: string,
): Promise<{ connection: TerminalConnectionToken; payment: TerminalPaymentIntent }> {
  const [connection, payment] = await Promise.all([
    createTerminalConnectionToken(client),
    createTerminalPaymentIntent(client, invoiceId),
  ]);
  return { connection, payment };
}
