import { z } from 'zod';
import { verifyWebhookSignature, handleWebhookEvent, WebhookRepository } from '../webhooks/webhook-handler';
import { instrument } from '../monitoring/instrumentation';

// Single source of truth for the event types we process. The `StripeEventType`
// union and the runtime `VALID_EVENT_TYPES` guard both derive from this array
// so they cannot drift apart.
const SUPPORTED_EVENT_TYPES = [
  'checkout.session.completed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
] as const;

export type StripeEventType = (typeof SUPPORTED_EVENT_TYPES)[number];

export interface StripeWebhookResult {
  eventId: string;
  eventType: StripeEventType;
  invoiceId?: string;
  amountCents?: number;
  currency?: string;
  paymentIntentId?: string;
  duplicate: boolean;
}

export interface StripeWebhookConfig {
  webhookSecret: string;
  toleranceSeconds?: number;
}

const VALID_EVENT_TYPES: readonly StripeEventType[] = SUPPORTED_EVENT_TYPES;

// Runtime shape of the fields we read off `data.object`. Every field is
// optional (shapes differ per event type) but, when present, must be the
// expected primitive — so a drifted/forged-shape payload fails loudly here
// instead of silently coercing via an `as` cast. Unknown keys pass through.
const stripeEventObjectSchema = z
  .object({
    id: z.string().optional(),
    amount: z.number().optional(),
    amount_total: z.number().optional(),
    currency: z.string().optional(),
    payment_intent: z.string().optional(),
    client_reference_id: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export function parseStripeEvent(payload: Record<string, unknown>): {
  eventType: string;
  invoiceId?: string;
  amountCents?: number;
  currency?: string;
  paymentIntentId?: string;
} {
  const eventType = payload.type;
  if (typeof eventType !== 'string' || !eventType) {
    throw new Error('Missing event type in payload');
  }

  const data = payload.data as Record<string, unknown> | undefined;
  const rawObject = data?.object;
  if (!rawObject || typeof rawObject !== 'object') {
    throw new Error('Missing data.object in payload');
  }

  const result = stripeEventObjectSchema.safeParse(rawObject);
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid Stripe event object shape: ${fields}`);
  }
  const object = result.data;
  const metadataInvoiceId =
    typeof object.metadata?.invoiceId === 'string' ? object.metadata.invoiceId : undefined;

  let invoiceId: string | undefined;
  let amountCents: number | undefined;
  let currency: string | undefined;
  let paymentIntentId: string | undefined;

  if (eventType === 'checkout.session.completed') {
    invoiceId = metadataInvoiceId || object.client_reference_id || undefined;
    amountCents = object.amount_total;
    currency = object.currency;
    paymentIntentId = object.payment_intent;
  } else if (eventType === 'payment_intent.succeeded' || eventType === 'payment_intent.payment_failed') {
    invoiceId = metadataInvoiceId;
    amountCents = object.amount;
    currency = object.currency;
    paymentIntentId = object.id;
  }

  return { eventType, invoiceId, amountCents, currency, paymentIntentId };
}

async function handleStripeWebhookInner(
  rawBody: string,
  signature: string,
  config: StripeWebhookConfig,
  webhookRepo: WebhookRepository
): Promise<StripeWebhookResult> {
  // 1. Verify signature
  const valid = verifyWebhookSignature(
    rawBody,
    signature,
    config.webhookSecret,
    config.toleranceSeconds ?? 300
  );
  if (!valid) throw new Error('Invalid webhook signature');

  // 2. Parse payload
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new Error('Malformed webhook body');
  }

  const parsed = parseStripeEvent(payload);

  if (!VALID_EVENT_TYPES.includes(parsed.eventType as StripeEventType)) {
    throw new Error(`Unsupported event type: ${parsed.eventType}`);
  }

  const eventId = (payload.id as string) || '';
  if (!eventId) throw new Error('Missing event ID in payload');

  // 3. Check idempotency via webhookRepo
  const { event, duplicate } = await handleWebhookEvent(
    'stripe',
    parsed.eventType,
    payload,
    eventId,
    webhookRepo
  );

  // 4. Return parsed event
  return {
    eventId: event.id,
    eventType: parsed.eventType as StripeEventType,
    invoiceId: parsed.invoiceId,
    amountCents: parsed.amountCents,
    currency: parsed.currency,
    paymentIntentId: parsed.paymentIntentId,
    duplicate,
  };
}

/**
 * §11 H3: Wrapped with instrument() so Stripe webhook failures are tagged
 * `path=stripe-webhook` and captured to Sentry before the error rethrows.
 * Tag extractor is omitted because this handler receives only the raw
 * payload + signature — tenant_id lives inside the parsed payload metadata
 * and isn't reliable until after the failure point, so the path tag alone
 * drives the alert rule (sufficient for §11 H3 acceptance criteria).
 */
export const handleStripeWebhook = instrument(handleStripeWebhookInner, {
  path: 'stripe-webhook',
});
