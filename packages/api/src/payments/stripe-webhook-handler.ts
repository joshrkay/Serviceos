import { verifyWebhookSignature, handleWebhookEvent, WebhookRepository } from '../webhooks/webhook-handler';

export type StripeEventType = 'checkout.session.completed' | 'payment_intent.succeeded' | 'payment_intent.payment_failed';

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

const VALID_EVENT_TYPES: StripeEventType[] = [
  'checkout.session.completed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
];

export function parseStripeEvent(payload: Record<string, unknown>): {
  eventType: string;
  invoiceId?: string;
  amountCents?: number;
  currency?: string;
  paymentIntentId?: string;
} {
  const eventType = payload.type as string;
  if (!eventType) throw new Error('Missing event type in payload');

  const data = payload.data as Record<string, unknown> | undefined;
  const object = data?.object as Record<string, unknown> | undefined;

  if (!object) throw new Error('Missing data.object in payload');

  let invoiceId: string | undefined;
  let amountCents: number | undefined;
  let currency: string | undefined;
  let paymentIntentId: string | undefined;

  if (eventType === 'checkout.session.completed') {
    const metadata = object.metadata as Record<string, unknown> | undefined;
    invoiceId = (metadata?.invoiceId as string) || (object.client_reference_id as string) || undefined;
    amountCents = object.amount_total as number | undefined;
    currency = object.currency as string | undefined;
    paymentIntentId = object.payment_intent as string | undefined;
  } else if (eventType === 'payment_intent.succeeded' || eventType === 'payment_intent.payment_failed') {
    const metadata = object.metadata as Record<string, unknown> | undefined;
    invoiceId = metadata?.invoiceId as string | undefined;
    amountCents = object.amount as number | undefined;
    currency = object.currency as string | undefined;
    paymentIntentId = object.id as string | undefined;
  }

  return { eventType, invoiceId, amountCents, currency, paymentIntentId };
}

export async function handleStripeWebhook(
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
